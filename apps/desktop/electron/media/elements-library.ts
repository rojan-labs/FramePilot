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
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import type {
  ElementAssetWire,
  ElementMaterializeRequest,
  ElementMaterializeResult,
} from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';
import { STICKER_ID_PATTERN, stickerSourceUrl, type StickerCatalog } from '@framepilot/ai-sdk';
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
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** ENOSPC has one honest answer, and it is not "the copy failed". */
const isDiskFull = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === 'ENOSPC';

export class ElementsLibrary {
  private readonly io: ElementsLibraryIO;
  /** One copy per (project, element) at a time: a double-click or two agent calls copy once. */
  private readonly inFlight = new Map<string, Promise<ElementMaterializeResult>>();

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
    const started = this.materializeUnshared(request).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  private async materializeUnshared(
    request: ElementMaterializeRequest,
  ): Promise<ElementMaterializeResult> {
    const startedAt = Date.now();
    if (!STICKER_ID_PATTERN.test(request.elementId)) {
      return { ok: false, error: 'unknown_element' };
    }
    const catalog = await this.options.catalog();
    const item = catalog.byId.get(request.elementId);
    if (item === undefined) return { ok: false, error: 'unknown_element' };
    if (item.availability !== 'bundled' || item.file === undefined || item.sha256 === undefined) {
      // A packaged sticker needs the desktop installer's set (EL6b), which this build lacks.
      return { ok: false, error: 'library_missing' };
    }
    const relativePath = path.posix.join(
      mediaRelativeDir(request.projectId),
      'elements',
      catalog.library,
      `${item.id}.webp`,
    );
    const target = resolveWithin(this.options.projectsRoot, relativePath);
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
      if (await this.io.exists(target)) {
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
