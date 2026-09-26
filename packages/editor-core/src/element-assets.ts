/**
 * What an element asset is (plan/elements 04 §1), in a leaf module every other one can import:
 * a sticker is an ordinary `image` asset whose provenance names an element library. Derived, never
 * stored — placement, footage indexing, repeats, picture occupancy, the agent's asset views and
 * Credits all ask this one question.
 */
import type { Asset } from '@framepilot/timeline-schema';

/** The sticker libraries, by the `source.provider` their assets carry. */
export const ELEMENT_PROVIDERS: readonly string[] = ['fluent-emoji'];

/**
 * Whether `asset` is an element (a sticker) rather than footage: derived from its provenance,
 * never stored. The Inspector, the agent's asset views, footage indexing and Credits all ask this
 * one question.
 */
export function isElementAsset(asset: Pick<Asset, 'source'> | undefined): boolean {
  const provider = asset?.source?.provider;
  return provider !== undefined && ELEMENT_PROVIDERS.includes(provider);
}

/**
 * The asset id a sticker gets: `element_<library>_<itemId>`, deterministic so adding the same
 * sticker twice reuses one asset. The desktop's `sourcedAssetId('element', …)` is pinned to this
 * formula by its own test.
 */
export function elementAssetId(library: string, itemId: string): string {
  return `element_${library}_${itemId}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * The art's share of a library sticker file's height. The library build pads every sticker by 12%
 * on each side (room for an outline or a shadow), so 256 px of art sit in a 318 px file; placing a
 * sticker from the bin, where only the asset is at hand, still sizes the art, not the margin.
 */
export function elementArtFraction(asset: Pick<Asset, 'source'> | undefined): number {
  return asset?.source?.provider === 'fluent-emoji' ? 256 / 318 : 1;
}

