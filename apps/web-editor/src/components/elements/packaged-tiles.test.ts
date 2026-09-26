/**
 * Packaged sticker tiles (plan/elements EL6b.2): the 1,344 stickers the desktop installer ships
 * live outside the renderer's files, so their tiles come over `framepilot:elements:thumbnail` as
 * bytes. The source asks once whether the set is there, fetches only the tiles on screen that it
 * lacks, in bounded batches, and keeps each one for the session.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElementThumbnailRequest, ElementThumbnailResult } from '@framepilot/shared-types';
import { MAX_TILES_PER_REQUEST, createPackagedTileSource } from './packaged-tiles.js';

const bytes = (id: string): Uint8Array => new TextEncoder().encode(id);

/** A main process that ships `packaged` and answers each id with its own bytes. */
function main(packaged: boolean, missing: readonly string[] = []) {
  return vi.fn(async (request: ElementThumbnailRequest): Promise<ElementThumbnailResult> => ({
    ok: true,
    packaged,
    thumbs: request.elementIds
      .filter((id) => packaged && !missing.includes(id))
      .map((elementId) => ({ elementId, webp: bytes(elementId) })),
  }));
}

const urls = () => {
  let next = 0;
  return vi.fn((_data: Uint8Array) => `blob:tile-${String((next += 1))}`);
};

describe('createPackagedTileSource', () => {
  it('asks once, with an empty request, whether this build ships the packaged set', async () => {
    const request = main(true);
    const source = createPackagedTileSource(request, urls());
    expect(await source.present()).toBe(true);
    expect(await source.present()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ elementIds: [] });
  });

  it('reads no set, a refusal and a failed request all as "curated only"', async () => {
    expect(await createPackagedTileSource(main(false), urls()).present()).toBe(false);
    const refused = vi.fn(async (): Promise<ElementThumbnailResult> => ({
      ok: false,
      error: 'library_missing',
    }));
    expect(await createPackagedTileSource(refused, urls()).present()).toBe(false);
    const broken = vi.fn(async (): Promise<ElementThumbnailResult> => {
      throw new Error('no handler');
    });
    expect(await createPackagedTileSource(broken, urls()).present()).toBe(false);
  });

  it('fetches only the tiles it lacks, in bounded batches, and keeps each for the session', async () => {
    const request = main(true);
    const createUrl = urls();
    const source = createPackagedTileSource(request, createUrl);
    const ids = Array.from({ length: MAX_TILES_PER_REQUEST + 4 }, (_, i) => `s${String(i)}`);
    await source.load(ids);
    expect(request.mock.calls.map(([asked]) => asked.elementIds.length)).toEqual([
      MAX_TILES_PER_REQUEST,
      4,
    ]);
    expect(source.url('s0')).toBe('blob:tile-1');
    expect(createUrl.mock.calls[0]![0]).toEqual(bytes('s0'));

    request.mockClear();
    await source.load(['s0', 's1', 'fresh']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ elementIds: ['fresh'] });
  });

  it('never asks twice for a tile already on its way', async () => {
    const request = main(true);
    const source = createPackagedTileSource(request, urls());
    await Promise.all([source.load(['a', 'b']), source.load(['b', 'c'])]);
    const asked = request.mock.calls.flatMap(([call]) => call.elementIds);
    expect(asked.sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves a tile main could not answer free to be asked for again', async () => {
    const request = main(true, ['gone']);
    const source = createPackagedTileSource(request, urls());
    await source.load(['gone']);
    expect(source.url('gone')).toBeUndefined();
    await source.load(['gone']);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
