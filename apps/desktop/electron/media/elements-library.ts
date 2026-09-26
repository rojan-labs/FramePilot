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
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import type {
  ElementAssetWire,
  ElementMaterializeRequest,
  ElementMaterializeResult,
} from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';
import { STICKER_ID_PATTERN, stickerSourceUrl, type StickerCatalog } from '@framepilot/ai-sdk';
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
};

export interface ElementsLibraryOptions {
  /** Every write resolves inside it. */
  readonly projectsRoot: string;
  /** The folder holding the bundled sticker files (`full/`, `thumbs/`). */
  readonly bundledRoot: () => string;
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

/** ENOSPC has one honest answer, and it is not "the copy failed". */
const isDiskFull = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === 'ENOSPC';

export class ElementsLibrary {
  private readonly io: ElementsLibraryIO;
  /** One copy per (project, element) at a time: a double-click or two agent calls copy once. */
  private readonly inFlight = new Map<string, Promise<ElementMaterializeResult>>();
  /** Folders already swept of temporary files an earlier, crashed process left. */
  private readonly swept = new Set<string>();

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
    if (item.availability !== 'bundled' || item.file === undefined || item.sha256 === undefined) {
      // A packaged sticker needs the desktop installer's set (EL6b), which this build lacks.
      return { ok: false, error: 'library_missing' };
    }
    if (item.file !== bundledFile(item.id)) {
      // The generator names every file after its id; anything else is not a file it wrote.
      log.error('materialize: a catalogue entry names a file that is not its own', {
        elementId: item.id,
      });
      return { ok: false, error: 'library_missing' };
    }
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
      media: { width: item.width ?? null, height: item.height ?? null },
      sharpSize: item.sharpSize ?? null,
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
      if (size !== null && (item.bytes === undefined || size === item.bytes)) {
        const present = await this.io.readFile(target);
        if (sha256(present) === item.sha256) {
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

    const source = path.join(this.options.bundledRoot(), item.file);
    let bytes: Buffer;
    try {
      bytes = await this.io.readFile(source);
    } catch {
      log.error('materialize: bundled file missing', { elementId: item.id });
      return { ok: false, error: 'library_missing' };
    }
    if (sha256(bytes) !== item.sha256) {
      log.error('materialize: bundled file does not match the catalogue', { elementId: item.id });
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
