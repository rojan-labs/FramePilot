/**
 * Monitor debug views for a clip's mask stack (MK3.3, plan 10 "Monitor toolbar": View).
 *
 * WHY: an edge that is a few levels off, or a feather that eats into the subject, is invisible
 * in the finished picture. Editors inspect a mask the way Resolve and Premiere show it:
 *
 * - `overlay`: the whole picture, with what the mask removes tinted in the mask's colour;
 * - `mask`: the stack's alpha itself as a grey picture (white keeps, black removes);
 * - `checkerboard`: the clip alone, cut out, over a checkerboard, so partial alpha reads;
 * - `off`: the program picture, exactly what the export renders.
 *
 * The views change only what the monitor draws for the SELECTED clip; they are never baked into
 * a frame the parity oracle or an export reads (the view resets to `off` without a selection).
 */

export type MaskDebugView = 'off' | 'overlay' | 'mask' | 'checkerboard';

export const MASK_DEBUG_VIEWS: readonly {
  readonly value: MaskDebugView;
  readonly label: string;
}[] = [
  { value: 'off', label: 'Off' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'mask', label: 'Mask only' },
  { value: 'checkerboard', label: 'Checkerboard' },
];

/** Shader mode for the per-layer view pass (the checkerboard is a frame-level choice). */
export const MASK_VIEW_MODE: Readonly<Record<MaskDebugView, number>> = {
  off: 0,
  overlay: 1,
  mask: 2,
  checkerboard: 0,
};

/** How much of the mask colour covers fully removed pixels in the overlay view. */
export const OVERLAY_TINT_STRENGTH = 0.5;

/** Mask colour `#rrggbb` as 0..1 RGB; the schema's default blue when malformed. */
export function maskColorRgb(color: string | undefined): readonly [number, number, number] {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(color ?? '');
  if (match === null) return [0x3b / 255, 0x82 / 255, 0xf6 / 255];
  return [
    Number.parseInt(match[1]!, 16) / 255,
    Number.parseInt(match[2]!, 16) / 255,
    Number.parseInt(match[3]!, 16) / 255,
  ];
}

/**
 * Which layers a frame draws under a view: the checkerboard view isolates the viewed layer (the
 * layers below would hide the checkerboard it exists to show); every other view draws them all.
 *
 * @param layers - Back to front.
 * @param isViewed - Whether a layer is the one the view applies to.
 */
export function layersForMaskView<T>(
  view: MaskDebugView,
  layers: readonly T[],
  isViewed: (layer: T) => boolean,
): { readonly checkerboard: boolean; readonly layers: readonly T[] } {
  if (view !== 'checkerboard') return { checkerboard: false, layers };
  const viewed = layers.filter(isViewed);
  if (viewed.length === 0) return { checkerboard: false, layers };
  return { checkerboard: true, layers: viewed };
}
