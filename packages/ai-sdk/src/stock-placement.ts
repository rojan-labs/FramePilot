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
import {
  type AnyOperation,
  DEFAULT_STOCK_STILL_SECONDS,
  buildAddStockOps,
  buildStockBinOps,
  firstFreePictureStart,
  stockPlacementConflictReason,
} from '@framepilot/editor-core';

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
        /**
         * Source pixel dimensions (schema v21). Both or neither — half a shape is not a
         * shape. Declared here because omitting them is what discarded them: this schema
         * REBUILDS the media object field by field, so a field it does not name cannot
         * survive the process boundary however carefully the host sent it
         * (`shared-types/ipc.ts#StockDownloadedAssetWire` does send them, and the Stock
         * panel keeps them). An agent-downloaded stock clip arriving unmeasured is a clip
         * the placement guard must refuse for want of a shape (ADR 0170) and the
         * auto-reframe cannot reframe — on the media a b-roll request reaches for most.
         */
        width: z.number().nullish(),
        height: z.number().nullish(),
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

/**
 * What {@link stockOpsFromPayload} decided, or why it could not decide.
 *
 * `start` is absent for a BIN-ONLY download — the clip is in the media bin and nowhere on
 * the timeline, so there is no position to report and the note must not invent one.
 */
export type StockPlacementOutcome =
  | { readonly ok: true; readonly operations: readonly AnyOperation[]; readonly start?: number }
  | {
      readonly ok: false;
      /** The refusal as a sentence, already naming {@link StockPlacementRefusal.suggestedStart}. */
      readonly reason: string;
      /** The same refusal as data, for a caller that must act rather than read. */
      readonly refusal: StockPlacementRefusal;
    };

/**
 * A refused placement, in a shape the orchestrator can act on instead of parse.
 *
 * The sentence in `reason` is built from exactly these numbers, so a caller that
 * shows the text and a caller that reads the fields cannot describe the refusal
 * differently.
 */
export interface StockPlacementRefusal {
  readonly kind: 'picture_occupied';
  /** The span that was asked for and refused, in timeline seconds. */
  readonly requested: { readonly start: number; readonly end: number };
  /** The earliest start at or after `requested.start` where this clip does fit. */
  readonly suggestedStart: number;
}

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
  // NO POSITION MEANS THE BIN, not "the top of the sequence".
  //
  // `atSeconds ?? 0` used to make every download an immediate placement at 0s, so there was
  // no way to gather candidates before assembling a cut — and `buildAddStockOps` refuses a
  // span that already holds picture, which meant the SECOND download of a comparison always
  // failed on the first one. A captured run said twice that it was "locking the media into
  // the bin first so the cut has something to sit on", found no tool that did that, and
  // reached for `add_asset` with a path it invented.
  //
  // Gathering is now what the absent argument means. Placement is unchanged when a position
  // is given, and `add_clip` places from the bin afterwards like any other asset.
  if (atSeconds === undefined) {
    return { ok: true, operations: buildStockBinOps(asset as Asset) };
  }
  const placement = buildAddStockOps(project.timeline, project.assets, asset as Asset, atSeconds);
  if (placement === null) {
    const start = atSeconds < 0 ? 0 : atSeconds;
    const durationSeconds = asset.durationSeconds ?? DEFAULT_STOCK_STILL_SECONDS;
    // Worded ONCE, in editor-core, so this refusal and the Stock panel's cannot
    // name different next steps for the same timeline. Lowercased because the
    // orchestrator embeds it as `Rejected "add_stock" — <reason>`.
    const sentence = stockPlacementConflictReason(
      project.timeline,
      project.assets,
      start,
      durationSeconds,
    )!;
    return {
      ok: false,
      reason: sentence.charAt(0).toLowerCase() + sentence.slice(1),
      refusal: {
        kind: 'picture_occupied',
        requested: { start, end: start + durationSeconds },
        suggestedStart: firstFreePictureStart(
          project.timeline,
          project.assets,
          durationSeconds,
          start,
        ),
      },
    };
  }
  return { ok: true, operations: placement.operations, start: placement.start };
}
