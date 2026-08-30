/**
 * Desktop → Python-sidecar asset-media client (plan/PLAN.md Phase 8 — "real
 * thumbnail previews").
 *
 * WHY in the main process: deriving waveform peaks and thumbnail frames is a
 * MoviePy/FFmpeg job and MUST stay out of the renderer (AGENTS.md render-vs-
 * preview rule). The renderer asks the main process to derive media for an
 * already-on-disk file; the main process POSTs the path to the FastAPI sidecar's
 * `/asset-media` route, which extracts frames + peaks deterministically and
 * returns project-root-relative POSIX paths. `fetch` is injected so this is
 * unit-tested offline without a live sidecar.
 *
 * Unlike `/render`, `/asset-media` decides success by HTTP status (non-2xx →
 * error). A failure here is non-fatal to the import: the caller keeps the asset
 * without derived media (the timeline draws a skeleton) and surfaces a
 * non-blocking status, so a stopped engine never blocks bringing media in.
 */
import type { StockDownloadedAssetWire } from '@framepilot/shared-types';
import type { AssetMedia } from '@framepilot/timeline-schema';
import type { ImportAssetRequest, ImportAssetResult } from '../ipc/contract.js';

/**
 * A SUCCESSFUL derivation, as {@link importAssetViaSidecar} actually resolves it —
 * duration and kind at the top level, the derived media (proxy, thumbnails, peaks)
 * nested under `media`.
 *
 * WHY this is a named type rather than each caller restating the shape: the sourcing
 * services used to declare their own FLAT option shape (`{ proxyPath, peaks,
 * thumbnailPaths }`). Every optional field made that shape structurally assignable
 * from this one, so the compiler was silent while `derived.proxyPath` read `undefined`
 * forever. The engine transcoded a 540p proxy, wrote it to disk, and the desktop stored
 * `proxyPath: null` — so a montage built from 55 sourced clips previewed against 1.5 GB
 * of 4K originals with 63 MB of proxies sitting unused beside them. Binding both callers
 * to this exact type is what makes that drift a compile error instead of a memory spike.
 */
export type DerivedAssetMedia = Extract<ImportAssetResult, { ok: true }>;

// ---------------------------------------------------------------------------
// Compile-time lockstep: the wire media shapes vs. the persisted `AssetMedia`
// ---------------------------------------------------------------------------

/**
 * WHY these assertions exist, and why HERE.
 *
 * Both wire types rebuild the media object field by field, so a field the wire type does
 * not name cannot survive no matter what the engine probed — and nothing fails when one is
 * forgotten. That is exactly how schema v21's `width`/`height` were added to `AssetMedia`,
 * derived by the engine, forwarded by this client, and then silently discarded on both the
 * import and the stock paths: `list_assets` could not warn that a landscape clip would
 * letterbox in a vertical sequence, and the review's reframe check fell back to a generic
 * warning instead of naming the clips.
 *
 * `@framepilot/shared-types` cannot import `@framepilot/timeline-schema` (the dependency
 * runs the other way), so the check lives in a package that depends on both — the same
 * placement, and the same `AssertTrue<...>` device, `packages/ai-sdk/src/run-contracts.ts`
 * uses to pin `DurableRunMode`.
 *
 * KEY sets rather than full type equality: the wire types are `readonly` and permit `null`
 * where the Zod-inferred type does not, so exact value equality would fail for reasons that
 * are not drift. A missing or extra FIELD — the failure mode that actually loses data — is
 * what this catches.
 */
type MediaKeys<T> = keyof NonNullable<T>;
type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
/** Fails to compile unless the two key unions are exactly equal. */
type AssertTrue<T extends true> = T;

/** Import path: `ImportAssetResult['media']` must name every `AssetMedia` field. */
export type ImportAssetMediaLockstep = AssertTrue<
  MutuallyAssignable<MediaKeys<DerivedAssetMedia['media']>, keyof AssetMedia>
>;
/** Stock path: `StockDownloadedAssetWire['media']` must name every `AssetMedia` field. */
export type StockAssetMediaLockstep = AssertTrue<
  MutuallyAssignable<MediaKeys<StockDownloadedAssetWire['media']>, keyof AssetMedia>
>;

/** Default thumbnail-frame count when the request omits one. */
const DEFAULT_THUMBNAILS = 5;

/** Minimal shape of the sidecar's `/asset-media` JSON response we depend on. */
interface AssetMediaResponse {
  durationSeconds?: number | null;
  kind?: 'video' | 'audio' | 'image';
  /** Source pixel dimensions (schema v21). Absent for audio and for anything unprobeable. */
  width?: number | null;
  height?: number | null;
  peaks?: number[];
  peaksPerSecond?: number;
  thumbnailPaths?: string[];
  proxyPath?: string | null;
}

/**
 * Derive engine media (peaks + thumbnails) for an on-disk media file through the
 * sidecar.
 *
 * @param baseUrl - Sidecar base URL (e.g. `http://127.0.0.1:8765`).
 * @param req - The derive request; `inputPath` must already be sandbox-resolved.
 * @param fetchFn - Injectable `fetch` (defaults to the global) for testing.
 */
export async function importAssetViaSidecar(
  baseUrl: string,
  req: ImportAssetRequest,
  fetchFn: typeof fetch = fetch,
): Promise<ImportAssetResult> {
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/asset-media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input_path: req.inputPath,
        thumbnails: req.thumbnails ?? DEFAULT_THUMBNAILS,
        proxy: req.proxy ?? false,
        // Brain wiring (plan B0.4): with both ids the sidecar persists the
        // probe into the project's derived brain.sqlite; absent → no write.
        ...(req.projectId !== undefined && req.assetId !== undefined
          ? { projectId: req.projectId, assetId: req.assetId }
          : {}),
      }),
    });
  } catch (error) {
    // Network/transport failure (e.g. sidecar not running) — non-fatal upstream.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!response.ok) {
    // Do NOT forward the upstream response body to the renderer: the sidecar's
    // sandbox error embeds the absolute projects-root path (security review,
    // 2026-06-30 — LOW info-leak). Surface only the status; the body is dropped.
    return {
      ok: false,
      error: `Asset-media request failed (${response.status}).`,
    };
  }

  let body: AssetMediaResponse;
  try {
    body = (await response.json()) as AssetMediaResponse;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (body.kind !== 'video' && body.kind !== 'audio' && body.kind !== 'image') {
    return { ok: false, error: `Asset-media response missing a valid kind: ${String(body.kind)}` };
  }

  // Build the media object with only the fields the sidecar actually returned —
  // `exactOptionalPropertyTypes` forbids assigning an explicit `undefined` to an
  // optional field, and an absent field reads more cleanly downstream than a
  // present-but-undefined one.
  const media: {
    width?: number;
    height?: number;
    peaks?: number[];
    peaksPerSecond?: number;
    thumbnailPaths?: string[];
    proxyPath?: string;
  } = {};
  // Both or neither: half a shape is not a shape, and a reader that finds only a width
  // cannot decide anything with it. Absent means "not probed", never "square".
  if (typeof body.width === 'number' && typeof body.height === 'number') {
    media.width = body.width;
    media.height = body.height;
  }
  if (body.peaks !== undefined) media.peaks = body.peaks;
  if (body.peaksPerSecond !== undefined) media.peaksPerSecond = body.peaksPerSecond;
  if (body.thumbnailPaths !== undefined) media.thumbnailPaths = body.thumbnailPaths;
  if (body.proxyPath != null) media.proxyPath = body.proxyPath;

  return {
    ok: true,
    durationSeconds: body.durationSeconds ?? null,
    kind: body.kind,
    media,
  };
}
