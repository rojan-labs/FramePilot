/**
 * Masks fixed to the OUTPUT FRAME — an effect layer's mask stack in the preview (MK5.2).
 *
 * The TypeScript twin of `engine/python/framepilot_engine/render/frame_masks.py`. A clip's mask
 * is in display-corrected source pixels, mapped through the clip's crop and evaluated on the
 * asset clock; an adjustment lane has no asset, no crop and no speed, so its mask lives in
 * output-frame pixels on a clock that is simply seconds from the layer's `start`
 * (`space: 'frame'`, schema v22).
 *
 * Everything else is shared with the clip path: the same exact rasteriser, combine modes and
 * single quantisation, reached through {@link stackAlphaAt} with a stand-in owner whose "media
 * size" is the frame itself, so the mapping is the identity.
 *
 * What the export refuses, this refuses with the same sentence, so the monitor never draws an
 * adjustment the export would not write (`assert_frame_renderable`).
 */
import type { EffectLayer, MaskLayer } from '@framepilot/timeline-schema';
import { masksOf } from '@framepilot/timeline-schema';
import {
  ANALYTIC_KINDS,
  analyticRefusal,
  stackAlphaAt,
  type DrawnMask,
  type MaskPreviewRefusal,
  type MaskStackRaster,
  type ClipMaskStack,
} from './mask-stack.js';

/** Kinds an adjustment lane's mask cannot be yet, with the remedy (`_KIND_REFUSALS`). */
const KIND_REFUSALS: Partial<
  Record<MaskLayer['kind'], { task: MaskPreviewRefusal['task']; what: string }>
> = {
  key: { task: 'MK6', what: 'colour key masks preview once the key renderer ships' },
  layer: {
    task: null,
    what: "a track matte reads another clip's picture, which an adjustment lane cannot",
  },
  matte: {
    task: null,
    what: "an AI matte belongs to a clip's own picture, not to an adjustment lane",
  },
};

/** An effect layer's enabled masks, or why the monitor cannot draw them. */
export interface FrameMaskStack {
  readonly layerId: string;
  readonly masks: readonly DrawnMask[];
  readonly refusal: MaskPreviewRefusal | null;
  /** Whether the stack moves over the layer's span (a static one is rastered once). */
  readonly animated: boolean;
}

function refusal(
  layerId: string,
  mask: MaskLayer,
  task: MaskPreviewRefusal['task'],
  message: string,
): MaskPreviewRefusal {
  return { clipId: layerId, maskId: mask.id, task, message };
}

/** `assert_frame_renderable` for one enabled mask; `null` when the preview can draw it. */
function refusalFor(layerId: string, mask: MaskLayer): MaskPreviewRefusal | null {
  const kind = KIND_REFUSALS[mask.kind];
  if (kind !== undefined) {
    return refusal(layerId, mask, kind.task, `Mask not previewed yet: ${kind.what}.`);
  }
  if (mask.tracking !== undefined) {
    return refusal(
      layerId,
      mask,
      'MK7',
      'Mask not previewed yet: tracked masks preview once mask tracking ships.',
    );
  }
  if (mask.space !== 'frame') {
    return refusal(
      layerId,
      mask,
      null,
      "A mask on an adjustment lane is stored in a clip's source space. Redraw it on the lane.",
    );
  }
  if (mask.target.kind !== 'alpha') {
    return refusal(
      layerId,
      mask,
      null,
      "A mask on an adjustment lane limits one clip's effect. Retarget it to the whole adjustment.",
    );
  }
  if (mask.featherModel !== 'distance') {
    return refusal(
      layerId,
      mask,
      null,
      "A mask uses the legacy blur feather, which only migrated shapes have. Switch the mask's feather model to Distance.",
    );
  }
  if (ANALYTIC_KINDS.has(mask.kind)) {
    const analytic = analyticRefusal(mask);
    if (analytic !== null) return refusal(layerId, mask, null, analytic);
  }
  if (mask.kind === 'path') {
    const first = mask.pathKeyframes[0];
    const matched =
      first !== undefined &&
      mask.pathKeyframes.every((frame) => frame.points.length === first.points.length);
    if (!matched) {
      return refusal(
        layerId,
        mask,
        null,
        'A path mask has keyframes with different vertex counts. Insert or remove the vertex on every keyframe.',
      );
    }
  }
  return null;
}

/** `layer_mask_stack`: an effect layer's enabled stack, or `null` when it is unmasked. */
export function effectLayerMaskStack(layer: EffectLayer): FrameMaskStack | null {
  const enabled = masksOf(layer).filter((mask) => mask.enabled);
  if (enabled.length === 0) return null;
  for (const mask of enabled) {
    const refused = refusalFor(layer.id, mask);
    if (refused !== null) {
      return { layerId: layer.id, masks: [], refusal: refused, animated: false };
    }
  }
  const masks = enabled as DrawnMask[];
  return {
    layerId: layer.id,
    masks,
    refusal: null,
    animated: masks.some(
      (mask) =>
        mask.keyframes.length > 0 || (mask.kind === 'path' && mask.pathKeyframes.length > 1),
    ),
  };
}

/**
 * The stand-in owner the shared evaluator needs: no crop, and a "media size" equal to the frame,
 * which makes the source → raster mapping the identity; `sourceStart: 0` with no speed makes the
 * mask clock the layer-local one (`FrameOwner`).
 */
function frameOwner(stack: FrameMaskStack, width: number, height: number): ClipMaskStack {
  const clip = {
    id: stack.layerId,
    assetId: '',
    trackId: '',
    start: 0,
    end: 0,
    sourceStart: 0,
    sourceEnd: 0,
    effects: [],
    keyframes: [],
  };
  // Cast rather than spell the whole stack out: this owner is a shim, and naming every field
  // would make it break whenever the clip-side stack grows one.
  return {
    clip,
    size: { width, height },
    alpha: stack.masks,
    byEffect: new Map(),
    mattes: [],
    refusal: null,
  } as unknown as ClipMaskStack;
}

/** `FrameMaskStack.alpha_at`: the stack's exact float64 alpha on a `width`×`height` frame. */
export function frameStackAlphaAt(
  stack: FrameMaskStack,
  width: number,
  height: number,
  localTime: number,
): Float64Array | null {
  if (stack.refusal !== null || stack.masks.length === 0 || width <= 0 || height <= 0) return null;
  return stackAlphaAt(
    frameOwner(stack, width, height),
    { kind: 'alpha' },
    width,
    height,
    Math.max(0, localTime),
  );
}

/** Rastered frame-space stacks by signature; a static stack is drawn once per frame size. */
export class FrameMaskRasterCache {
  private readonly entries = new Map<string, MaskStackRaster>();

  constructor(private readonly capacity = 16) {}

  /**
   * The 8-bit raster of an effect layer's stack, or `null` when it draws nothing.
   *
   * @param stack - From {@link effectLayerMaskStack}.
   * @param width - Output frame width the layer is applied at.
   * @param height - Output frame height.
   * @param localTime - Seconds from the layer's `start`.
   */
  raster(
    stack: FrameMaskStack,
    width: number,
    height: number,
    localTime: number,
  ): MaskStackRaster | null {
    if (stack.refusal !== null || stack.masks.length === 0 || width <= 0 || height <= 0) {
      return null;
    }
    const key = [
      stack.layerId,
      `${String(width)}x${String(height)}`,
      stack.animated ? String(localTime) : 'static',
      stack.masks.map((mask) => `${mask.id}:${String(mask.mode)}`).join(','),
    ].join('|');
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const alpha = frameStackAlphaAt(stack, width, height, localTime);
    if (alpha === null) return null;
    const alpha8 = new Uint8Array(alpha.length);
    // The evaluator already quantised; `* 255` recovers those exact bytes.
    for (let i = 0; i < alpha.length; i += 1) alpha8[i] = Math.round(alpha[i]! * 255);
    const raster: MaskStackRaster = { width, height, alpha8, scale: 1 };
    if (this.entries.size >= this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, raster);
    return raster;
  }

  clear(): void {
    this.entries.clear();
  }
}
