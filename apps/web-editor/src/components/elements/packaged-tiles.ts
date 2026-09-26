/**
 * Tiles of the packaged stickers (plan/elements EL6b.2, 06 §2).
 *
 * The curated stickers' tiles are the renderer's own files. The other 1,344 ship in the desktop
 * installer's resources, which the renderer cannot reach (its CSP and the sandbox, on purpose), so
 * their tiles come over `framepilot:elements:thumbnail` as WebP bytes and are shown as `blob:`
 * URLs. The source asks once whether the set is there, fetches only the tiles on screen that it
 * lacks, in bounded batches, and keeps each for the session: the whole set is ≈ 6 MB of tiles,
 * less than one scroll of thumbnails would cost to fetch again.
 */
import type { ElementThumbnailRequest, ElementThumbnailResult } from '@framepilot/shared-types';
import { createLogger } from '@framepilot/shared-types';
import { elementsThumbnail } from '../../editor/bridge.js';

const log = createLogger('web-editor:sticker-tiles');

/** What one request may ask for; main holds requests to the same bound. */
export const MAX_TILES_PER_REQUEST = 96;

/** Where packaged tiles come from, for the Stickers tab (tests pass their own). */
export interface PackagedTileSource {
  /** Whether this build ships the packaged set; asked of main once. */
  present(): Promise<boolean>;
  /** The tile's `blob:` URL once loaded, else `undefined`. */
  url(elementId: string): string | undefined;
  /** Fetch the tiles among `elementIds` that are neither loaded nor on their way. */
  load(elementIds: readonly string[]): Promise<void>;
}

type RequestTiles = (request: ElementThumbnailRequest) => Promise<ElementThumbnailResult>;

/**
 * @param request - Asks main for tiles (`elementsThumbnail`).
 * @param createUrl - Turns a tile's bytes into a URL an `<img>` shows.
 */
export function createPackagedTileSource(
  request: RequestTiles,
  createUrl: (webp: Uint8Array) => string,
): PackagedTileSource {
  const urls = new Map<string, string>();
  const pending = new Set<string>();
  let presence: Promise<boolean> | null = null;

  const fetchBatch = async (batch: readonly string[]): Promise<void> => {
    try {
      const answer = await request({ elementIds: batch });
      if (!answer.ok) {
        log.warn('packaged tiles refused', { error: answer.error });
        return;
      }
      for (const thumb of answer.thumbs) {
        if (!urls.has(thumb.elementId)) urls.set(thumb.elementId, createUrl(thumb.webp));
      }
    } catch (error) {
      log.warn('packaged tiles failed', { error: String(error) });
    } finally {
      for (const elementId of batch) pending.delete(elementId);
    }
  };

  return {
    present() {
      presence ??= request({ elementIds: [] }).then(
        (answer) => answer.ok && answer.packaged,
        (error: unknown) => {
          log.warn('could not ask for the packaged set', { error: String(error) });
          return false;
        },
      );
      return presence;
    },
    url: (elementId) => urls.get(elementId),
    async load(elementIds) {
      const wanted = [...new Set(elementIds)].filter((id) => !urls.has(id) && !pending.has(id));
      if (wanted.length === 0) return;
      for (const elementId of wanted) pending.add(elementId);
      const batches: string[][] = [];
      for (let start = 0; start < wanted.length; start += MAX_TILES_PER_REQUEST) {
        batches.push(wanted.slice(start, start + MAX_TILES_PER_REQUEST));
      }
      await Promise.all(batches.map(fetchBatch));
    },
  };
}

let shared: PackagedTileSource | null = null;

/** The app's one source, over the desktop bridge; created on first use. */
export function packagedTiles(): PackagedTileSource {
  shared ??= createPackagedTileSource(
    (request) => elementsThumbnail(request),
    // A copy (a few KB) gives the Blob its own ArrayBuffer, whatever the IPC handed over.
    (webp) => URL.createObjectURL(new Blob([webp.slice()], { type: 'image/webp' })),
  );
  return shared;
}
