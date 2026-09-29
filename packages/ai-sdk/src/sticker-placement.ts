/**
 * The agent's `add_sticker`, as operations (plan/elements EL6a.7, 07 §3): the host copied the
 * sticker's file into the project and returned its asset; this turns that and the call's
 * arguments into the SAME operations the Stickers tab builds (`buildAddStickerOps`), so a sticker
 * the agent placed and one placed by hand are the same data. It never takes the stock cutaway
 * path, which would cover-crop a sticker to the full frame.
 */
import { z } from 'zod';
import {
  applyProjectPatch,
  buildAddStickerOps,
  elementRectAt,
  type AnyOperation,
  type FrameRect,
  type Patch,
} from '@framepilot/editor-core';
import type { Asset, Project } from '@framepilot/timeline-schema';
import { SAFE_AREA_INSET } from './critic.js';

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
  /**
   * Set when the sticker sits outside the platform safe area the Critic checks: which
   * `xPercent`/`yPercent` ranges keep it inside, for the reply (#150). Absent when it is inside.
   */
  readonly safeAreaNote?: string;
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
  const place = (offset: { readonly x: number; readonly y: number }) =>
    buildAddStickerOps(project, asset, start, end, {
      artFraction,
      // No size asked for: the builder's default, which stays sharp on a tall or 4K frame.
      ...(args.sizePercent !== undefined ? { height: args.sizePercent / 100 } : {}),
      offset,
      ...(args.trackId !== undefined ? { trackId: args.trackId } : {}),
    });
  const asked = {
    x: Math.round((((args.xPercent ?? 50) - 50) / 100) * width),
    y: Math.round((((args.yPercent ?? 50) - 50) / 100) * height),
  };
  let placed = place(asked);
  // Measured, not estimated: the frame plan's rect for the art, as the Critic will see it.
  let rect = drawnRect(project, placed.operations, placed.clipId, start);
  if (rect !== null) {
    // Whole pixels, rounded away from the edge, so the moved art is fully inside.
    const pixels = (fraction: number, frame: number): number =>
      Math.sign(fraction) * Math.ceil(Math.abs(fraction) * frame - 1e-6);
    const shift = {
      x: pixels(intoFrame(rect.x, rect.width), width),
      y: pixels(intoFrame(rect.y, rect.height), height),
    };
    if (shift.x !== 0 || shift.y !== 0) {
      // Partly off the frame: moved in just far enough, as add_text_layer keeps its box in frame.
      placed = place({ x: asked.x + shift.x, y: asked.y + shift.y });
      rect = drawnRect(project, placed.operations, placed.clipId, start);
    }
  }
  const safeAreaNote = rect === null ? undefined : outsideSafeAreaNote(rect);
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
  return {
    operations,
    clipId: placed.clipId,
    trackId: placed.trackId,
    start,
    end,
    ...(safeAreaNote === undefined ? {} : { safeAreaNote }),
  };
}

/** Where the sticker's art is drawn at `time` once `operations` apply, as frame fractions. */
function drawnRect(
  project: Project,
  operations: readonly AnyOperation[],
  clipId: string,
  time: number,
): FrameRect | null {
  const patch: Patch = {
    patchId: `sticker_probe_${clipId}` as Patch['patchId'],
    createdBy: 'agent',
    reason: 'Measure sticker placement',
    operations: [...operations],
  };
  return elementRectAt(applyProjectPatch(project, patch), clipId, time);
}

/** The frame fraction to move `[start, start + size]` by to lie in `[0, 1]`; 0 when it cannot. */
function intoFrame(start: number, size: number): number {
  if (size > 1) return 0;
  if (start < 0) return -start;
  return Math.min(0, 1 - (start + size));
}

/**
 * The reply's sentence for a sticker outside the Critic's safe area, or `undefined` inside it.
 * The ranges are the centres that keep THIS sticker's drawn art inside the margin, so the model
 * can move it in one call; a sticker too big for the margin is told to shrink instead.
 */
function outsideSafeAreaNote(rect: FrameRect): string | undefined {
  const lo = SAFE_AREA_INSET;
  const hi = 1 - SAFE_AREA_INSET;
  const eps = 1e-6;
  const inside =
    rect.x >= lo - eps &&
    rect.y >= lo - eps &&
    rect.x + rect.width <= hi + eps &&
    rect.y + rect.height <= hi + eps;
  if (inside) return undefined;
  const margin = Math.round(SAFE_AREA_INSET * 100);
  const range = (size: number): [number, number] | null => {
    const from = Math.ceil((lo + size / 2) * 100);
    const to = Math.floor((hi - size / 2) * 100);
    return from <= to ? [from, to] : null;
  };
  const xs = range(rect.width);
  const ys = range(rect.height);
  if (xs === null || ys === null) {
    return (
      `It is too big to sit inside the ${String(margin)}% safe area the review checks; ` +
      'a smaller sizePercent would fit it.'
    );
  }
  return (
    `It sits outside the ${String(margin)}% safe area the review checks. To keep it inside, ` +
    `use xPercent ${String(xs[0])}–${String(xs[1])} and yPercent ${String(ys[0])}–${String(ys[1])}` +
    ' (delete_clip it and add_sticker it there), or leave it if the edge is deliberate.'
  );
}
