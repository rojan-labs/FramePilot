/**
 * The agent's `add_sticker`, as operations (plan/elements EL6a.7, 07 §3): the host copied the
 * sticker's file into the project and returned its asset; this turns that and the call's
 * arguments into the SAME operations the Stickers tab builds (`buildAddStickerOps`), so a sticker
 * the agent placed and one placed by hand are the same data. It never takes the stock cutaway
 * path, which would cover-crop a sticker to the full frame.
 */
import { z } from 'zod';
import {
  buildAddStickerOps,
  type AnyOperation,
  STICKER_DEFAULT_HEIGHT,
} from '@framepilot/editor-core';
import type { Asset, Project } from '@framepilot/timeline-schema';

/** How long a sticker stays when the call gives no end. */
export const STICKER_DEFAULT_SECONDS = 3;

/** What the host hands back for `add_sticker`: the asset its file became. */
export const StickerAssetPayloadSchema = z.object({
  asset: z.object({
    id: z.string().regex(/^element_[a-z0-9]+_[a-z0-9_]+$/),
    path: z.string().min(1),
    kind: z.literal('image'),
    media: z.object({ width: z.number().nullable(), height: z.number().nullable() }),
    sharpSize: z.number().nullable(),
    source: z.object({
      provider: z.string().min(1),
      remoteId: z.string().min(1),
      license: z.string().min(1),
      licenseUrl: z.string(),
      attributionRequired: z.boolean(),
      attribution: z.string(),
      creator: z.string(),
      sourceUrl: z.string(),
      fetchedAt: z.string(),
    }),
  }),
});
export type StickerAssetPayload = z.infer<typeof StickerAssetPayloadSchema>;

/** The placement arguments `add_sticker` takes (its schema validated them). */
export interface StickerCallArgs {
  readonly start: number;
  readonly end?: number;
  readonly xPercent?: number;
  readonly yPercent?: number;
  readonly sizePercent?: number;
  readonly rotation?: number;
  readonly trackId?: string;
}

/** Where a placed sticker landed, for the reply. */
export interface StickerPlacementResult {
  readonly operations: readonly AnyOperation[];
  readonly clipId: string;
  readonly trackId: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The operations that place the host's sticker as the call asks.
 *
 * @param project - The run's working project.
 * @param payload - What the host returned (already schema-checked).
 * @param args - The call's placement arguments.
 */
export function stickerOpsFromCall(
  project: Project,
  payload: StickerAssetPayload,
  args: StickerCallArgs,
): StickerPlacementResult {
  const wire = payload.asset;
  const asset = {
    id: wire.id,
    path: wire.path,
    kind: 'image',
    media:
      wire.media.width !== null && wire.media.height !== null
        ? { width: wire.media.width, height: wire.media.height }
        : {},
    source: wire.source,
  } as Asset;
  const start = Math.max(0, args.start);
  const end =
    args.end !== undefined && args.end > start ? args.end : start + STICKER_DEFAULT_SECONDS;
  const { width, height } = project.resolution;
  const artFraction =
    wire.sharpSize !== null && wire.media.height !== null && wire.media.height > 0
      ? wire.sharpSize / wire.media.height
      : 1;
  const placed = buildAddStickerOps(project, asset, start, end, {
    artFraction,
    height: args.sizePercent !== undefined ? args.sizePercent / 100 : STICKER_DEFAULT_HEIGHT,
    offset: {
      x: Math.round((((args.xPercent ?? 50) - 50) / 100) * width),
      y: Math.round((((args.yPercent ?? 50) - 50) / 100) * height),
    },
    ...(args.trackId !== undefined ? { trackId: args.trackId } : {}),
  });
  const operations: AnyOperation[] = [...placed.operations];
  if (args.rotation !== undefined && args.rotation !== 0) {
    operations.push({
      type: 'add_keyframes',
      clipId: placed.clipId,
      keyframes: [
        {
          id: `kf_${placed.clipId}_rotation_base`,
          time: 0,
          property: 'rotation',
          value: args.rotation,
          easing: 'linear',
        },
      ],
      replace: true,
    });
  }
  return { operations, clipId: placed.clipId, trackId: placed.trackId, start, end };
}
