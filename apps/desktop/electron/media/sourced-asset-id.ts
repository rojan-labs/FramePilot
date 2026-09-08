/**
 * The project asset id a sourced download gets, in one place.
 *
 * Four call sites minted this string independently — the Stock panel
 * (`StockPanel.stockAssetId`), the Sounds panel (`SoundsPanel`), the agent's `add_stock`
 * host and `add_music` in `main.ts` — and every one of them has to agree, because the id
 * is what ties three separate facts together: the asset row the renderer puts in
 * `project.fp.json`, the brain row `/asset-media` writes, and the visual-index enrolment
 * that reads that brain row. A single character of drift and the ledger silently indexes
 * an asset the project does not have.
 *
 * The renderer keeps its own copies (it cannot import from `electron/`), pinned by their
 * own tests to this exact formula.
 */

/** Which acquisition path minted the asset, and therefore the id's prefix. */
export type SourcedAssetKind = 'stock' | 'music';

/**
 * Build the deterministic asset id for a sourced download.
 *
 * @param kind - `stock` for photo/video sourcing, `music` for tracks.
 * @param provider - The provider that served it (e.g. `pexels`, `openverse`).
 * @param remoteId - The provider's own id for the item.
 * @returns The id, with everything outside `[A-Za-z0-9_]` replaced by `_`.
 */
export function sourcedAssetId(kind: SourcedAssetKind, provider: string, remoteId: string): string {
  return `${kind}_${provider}_${remoteId}`.replace(/[^a-zA-Z0-9_]/g, '_');
}
