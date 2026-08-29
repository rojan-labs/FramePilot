import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadBrowserWaveformPeaks,
  readWaveformResponseBounded,
  clearWaveformPeakCache,
} from './useWaveformPeaks.js';

afterEach(() => {
  clearWaveformPeakCache();
  vi.restoreAllMocks();
});

describe('loadBrowserWaveformPeaks', () => {
  it('deduplicates concurrent extraction for every visible cut of the same source', async () => {
    let resolve!: (peaks: number[]) => void;
    const pending = new Promise<number[]>((done) => {
      resolve = done;
    });
    const extractor = vi.fn(() => pending);

    const first = loadBrowserWaveformPeaks('asset_1', 'fp-media://clip.mp4', extractor);
    const second = loadBrowserWaveformPeaks('asset_1', 'fp-media://clip.mp4', extractor);
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    resolve([0.1, 1]);
    await expect(first).resolves.toEqual([0.1, 1]);
    await expect(second).resolves.toEqual([0.1, 1]);

    const cachedExtractor = vi.fn(async () => [9]);
    await expect(
      loadBrowserWaveformPeaks('asset_1', 'fp-media://clip.mp4', cachedExtractor),
    ).resolves.toEqual([0.1, 1]);
    expect(cachedExtractor).not.toHaveBeenCalled();
  });

  it('does not poison retries after a failed extraction', async () => {
    const fail = vi.fn(async () => {
      throw new Error('decode failed');
    });
    await expect(loadBrowserWaveformPeaks('a', 'src', fail)).rejects.toThrow('decode failed');

    const retry = vi.fn(async () => [0.5]);
    await expect(loadBrowserWaveformPeaks('a', 'src', retry)).resolves.toEqual([0.5]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keys cache and in-flight work by source as well as asset id', async () => {
    const extractor = vi.fn(async (src: string) => [src === 'one' ? 1 : 2]);
    await expect(loadBrowserWaveformPeaks('asset', 'one', extractor)).resolves.toEqual([1]);
    await expect(loadBrowserWaveformPeaks('asset', 'two', extractor)).resolves.toEqual([2]);
    expect(extractor).toHaveBeenCalledTimes(2);
  });
});

describe('readWaveformResponseBounded', () => {
  it('rejects a declared oversized source before materializing it', async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { 'content-length': '5' },
    });
    await expect(readWaveformResponseBounded(response, 4)).rejects.toThrow('exceeds 4 bytes');
  });

  it('enforces the limit for chunked responses with no content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    await expect(readWaveformResponseBounded(new Response(stream), 4)).rejects.toThrow(
      'exceeds 4 bytes',
    );
  });

  it('assembles an allowed chunked response exactly', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    const data = await readWaveformResponseBounded(new Response(stream), 3);
    expect([...new Uint8Array(data)]).toEqual([1, 2, 3]);
  });
});
