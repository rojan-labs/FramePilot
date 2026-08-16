/**
 * @framepilot/ai-sdk/providers/asr-keyring — comma-separated API-key failover for
 * the hosted ASR providers (groq/nvidia).
 *
 * WHY: the hosted-ASR key setting accepts a **comma-separated list** of keys (same
 * shape as the visual-embeddings key ring, see `brain/keyring.py`). When one key is
 * rate-limited or revoked, transcription should roll over to the next instead of
 * failing the whole request. This module is the single, shared place that parses the
 * list and drives the rotation, so both hosted providers behave identically.
 */
import type { Logger } from '@framepilot/shared-types';
import { ProviderError } from '../reliability/types.js';
import type { AsrResult } from './asr-types.js';

/**
 * Parse the comma-separated key setting into an ordered, de-duplicated list. Blank
 * entries and surrounding whitespace are dropped, so `"k1, ,k1 ,k2"` → `["k1","k2"]`.
 * A single key (no commas) is just a one-element ring.
 */
export function parseAsrKeyRing(apiKey?: string): string[] {
  if (!apiKey) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const raw of apiKey.split(',')) {
    const key = raw.trim();
    if (key !== '' && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Try `attempt` with each key in `keys` in order, rolling over to the next key when
 * one fails, and returning the first success.
 *
 * Rotation policy: a `bad_request` ({@link ProviderError} `kind`) is the request
 * itself being malformed — the next key would fail identically, so it fails fast
 * without burning the rest of the ring. Every other failure (auth on a revoked key,
 * rate-limit on an exhausted key, transient server/network) rotates to the next key.
 * When the ring is exhausted the last error is rethrown, so the caller sees the real
 * cause. An empty ring (misconfiguration — callers should check for a configured key
 * first) throws the same way, rather than silently resolving to nothing.
 */
export async function transcribeWithKeyRing(
  keys: readonly string[],
  attempt: (apiKey: string) => Promise<AsrResult>,
  log: Logger,
): Promise<AsrResult> {
  let lastError: unknown = new Error('transcribeWithKeyRing requires at least one key.');
  for (let index = 0; index < keys.length; index += 1) {
    try {
      return await attempt(keys[index]!);
    } catch (error) {
      lastError = error;
      const kind = error instanceof ProviderError ? error.kind : undefined;
      const isLastKey = index === keys.length - 1;
      // A malformed request never succeeds on another key — stop and surface it.
      if (kind === 'bad_request' || isLastKey) throw error;
      log.warn('transcribe → key failed, rotating to next key', {
        keyIndex: index,
        remaining: keys.length - index - 1,
        kind,
      });
    }
  }
  throw lastError;
}
