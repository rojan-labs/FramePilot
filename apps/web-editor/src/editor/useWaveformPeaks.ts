/**
 * Browser-side waveform peak extraction via Web Audio API.
 *
 * Engine peaks remain authoritative. Browser extraction is only a bounded fallback:
 * completed results live in a small LRU, concurrent consumers share one in-flight
 * decode, and source reads stop before a large original can be materialized in the
 * renderer. Render-vs-preview rule: this is display data only; it never feeds export.
 */
import { useState, useEffect } from 'react';
import type { AssetMedia } from '@framepilot/timeline-schema';
import { clipPeaks } from './selectors.js';
import { mediaSrc } from './media.js';
import { LruCache } from './lruCache.js';

const PEAKS_PER_SECOND = 100;
const MAX_CACHED_WAVEFORM_ASSETS = 32;
/** Hard ceiling for the renderer-only fallback. Large desktop media must use engine peaks. */
export const MAX_WAVEFORM_FALLBACK_BYTES = 32 * 1024 * 1024;

const peaksCache = new LruCache<string, number[]>(MAX_CACHED_WAVEFORM_ASSETS);
const peaksInFlight = new Map<string, Promise<number[]>>();
const cacheKey = (assetId: string, src: string): string => `${assetId}\u0000${src}`;

function extractPeaks(audioBuffer: AudioBuffer): number[] {
  const data = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const bucketSize = Math.max(1, Math.floor(sampleRate / PEAKS_PER_SECOND));
  const numBuckets = Math.ceil(data.length / bucketSize);
  let globalMax = 0;
  const raw = new Array<number>(numBuckets);

  for (let i = 0; i < numBuckets; i += 1) {
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize, data.length);
    let max = 0;
    for (let j = start; j < end; j += 1) {
      const value = Math.abs(data[j] ?? 0);
      if (value > max) max = value;
    }
    raw[i] = max;
    if (max > globalMax) globalMax = max;
  }

  return globalMax > 0 ? raw.map((peak) => peak / globalMax) : raw;
}

/** Read a response without ever allowing an unknown-length body to grow past `maxBytes`. */
export async function readWaveformResponseBounded(
  response: Response,
  maxBytes: number = MAX_WAVEFORM_FALLBACK_BYTES,
): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RangeError(`Waveform fallback source exceeds ${maxBytes} bytes.`);
  }

  if (!response.body) {
    const data = await response.arrayBuffer();
    if (data.byteLength > maxBytes) {
      throw new RangeError(`Waveform fallback source exceeds ${maxBytes} bytes.`);
    }
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('waveform fallback size limit');
      throw new RangeError(`Waveform fallback source exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function fetchAndExtract(src: string): Promise<number[]> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const arrayBuffer = await readWaveformResponseBounded(response);
  const audioContext = new AudioContext();
  try {
    return extractPeaks(await audioContext.decodeAudioData(arrayBuffer));
  } finally {
    void audioContext.close();
  }
}

/**
 * Resolve one source's full peak array. Concurrent clips referencing the same source
 * share the same promise, so a cut-up source can never start N duplicate decoders.
 */
export function loadBrowserWaveformPeaks(
  assetId: string,
  src: string,
  extractor: (source: string) => Promise<number[]> = fetchAndExtract,
): Promise<number[]> {
  const key = cacheKey(assetId, src);
  const cached = peaksCache.get(key);
  if (cached) return Promise.resolve(cached);
  const active = peaksInFlight.get(key);
  if (active) return active;

  const pending = extractor(src)
    .then((peaks) => {
      peaksCache.set(key, peaks);
      return peaks;
    })
    .finally(() => {
      peaksInFlight.delete(key);
    });
  peaksInFlight.set(key, pending);
  return pending;
}

/**
 * Drop the module-scoped peak caches (P6.2).
 *
 * Keyed by asset id + source URL, so a closed project's peaks can never be served
 * again — and a peak array for a ten-minute source is ~60,000 numbers. Called on
 * project switch, and by tests that must not inherit a previous case's peaks.
 */
export function clearWaveformPeakCache(): void {
  peaksCache.clear();
  peaksInFlight.clear();
}

/** How many assets' peaks are cached right now (tests, resource probes). */
export function waveformPeakCacheSize(): number {
  return peaksCache.size;
}

export interface WaveformPeaksResult {
  peaks: number[];
  loading: boolean;
}

export function useWaveformPeaks(
  assetId: string,
  media: AssetMedia | undefined,
  assetPath: string | undefined,
  sourceStart: number,
  sourceEnd: number,
): WaveformPeaksResult {
  const enginePeaks = clipPeaks(media, sourceStart, sourceEnd);
  const hasEngine = enginePeaks.length > 0;
  const src = assetPath ? mediaSrc(assetPath) : null;

  const [browserFullPeaks, setBrowserFullPeaks] = useState<number[] | null>(() =>
    src ? (peaksCache.get(cacheKey(assetId, src)) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (hasEngine || !src || src.startsWith('data:image')) return;
    const cached = peaksCache.get(cacheKey(assetId, src));
    if (cached) {
      setBrowserFullPeaks(cached);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void loadBrowserWaveformPeaks(assetId, src)
      .then((peaks) => {
        if (!cancelled) setBrowserFullPeaks(peaks);
      })
      .catch(() => {
        // Honest fallback: leave the timeline skeleton when bounded extraction is unavailable.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [assetId, hasEngine, src]);

  if (hasEngine) return { peaks: enginePeaks, loading: false };
  if (browserFullPeaks) {
    return {
      peaks: clipPeaks(
        { peaks: browserFullPeaks, peaksPerSecond: PEAKS_PER_SECOND },
        sourceStart,
        sourceEnd,
      ),
      loading: false,
    };
  }
  return { peaks: [], loading };
}
