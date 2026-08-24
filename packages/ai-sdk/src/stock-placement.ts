/**
 * @framepilot/ai-sdk/stock-placement — the `add_stock` host payload, and the
 * one rule for turning it into timeline operations.
 *
 * ## Why this is a module and not three lines in the orchestrator
 *
 * `add_stock` is a host-backed mutation: the trusted Electron main process
 * downloads the rendition and hands back an asset, and the orchestrator turns
 * that into the SAME reversible operations the Stock panel builds by hand. The
 * *shape* of that placement lives in `@framepilot/editor-core`
 * (`buildAddStockOps`), shared with the panel so the two cannot drift. What
 * lives here is the process boundary: the payload is **parsed, not trusted**, so
 * a malformed or empty download fails the tool closed instead of reporting a
 * completed edit on an unchanged timeline (ADR 0083).
 *
 * The mirror of `music-placement.ts`, for picture.
 */
import { z } from 'zod';
import type { Asset, Project } from '@framepilot/timeline-schema';
import { type AnyOperation, buildAddStockOps } from '@framepilot/editor-core';

/**
 * The host's `add_stock` payload.
 *
 * `atSeconds` is echoed back rather than re-derived, so the placement decision
 * stays with the orchestrator and the host stays download-only.
 */
export const StockAssetPayloadSchema = z.object({
  asset: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    // Stock is picture only. An audio payload arriving here would be a provider
    // or host bug, and placing it as picture would be worse than refusing.
    kind: z.union([z.literal('video'), z.literal('image')]),
    durationSeconds: z.number().positive().optional(),
    media: z
      .object({
        proxyPath: z.string().nullish(),
        peaks: z.array(z.number()).nullish(),
        peaksPerSecond: z.number().positive().nullish(),
        thumbnailPaths: z.array(z.string()).nullish(),
      })
      .nullish(),
    source: z.object({
      provider: z.string().min(1),
      remoteId: z.string().min(1),
      license: z.string().min(1),
      licenseUrl: z.string().optional(),
      attributionRequired: z.boolean(),
      attribution: z.string().optional(),
      creator: z.string().optional(),
      creatorUrl: z.string().optional(),
      sourceUrl: z.string().optional(),
      fetchedAt: z.string(),
    }),
  }),
  atSeconds: z.number().nonnegative().optional(),
});
export type StockAssetPayload = z.infer<typeof StockAssetPayloadSchema>;

/** What {@link stockOpsFromPayload} decided, or why it could not decide. */
export type StockPlacementOutcome =
  | { readonly ok: true; readonly operations: readonly AnyOperation[]; readonly start: number }
  | { readonly ok: false; readonly reason: string };

/**
 * The operations that place a downloaded stock asset, or the sentence explaining
 * why they do not exist.
 *
 * The occupancy refusal is re-checked here even though the host already checked
 * it before spending the download: the two checks run at different moments, and
 * between them the model may have moved the timeline. Both call the same
 * `editor-core` predicate, so they cannot disagree about the *rule* — only about
 * the *moment*, which is exactly what this second check exists to catch.
 *
 * @param project - The project as the orchestrator currently holds it.
 * @param payload - The parsed host payload.
 */
export function stockOpsFromPayload(
  project: Project,
  payload: StockAssetPayload,
): StockPlacementOutcome {
  const { asset, atSeconds } = payload;
  const placement = buildAddStockOps(
    project.timeline,
    project.assets,
    asset as Asset,
    atSeconds ?? 0,
  );
  if (placement === null) {
    const start = Math.max(0, atSeconds ?? 0);
    return {
      ok: false,
      reason:
        `there is already picture on the timeline at ${start.toFixed(1)}s. Stock cannot sit ` +
        'on top of existing footage yet — pick an empty stretch and try again.',
    };
  }
  return { ok: true, operations: placement.operations, start: placement.start };
}
