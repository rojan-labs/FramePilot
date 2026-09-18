/**
 * Track mattes and text as a mask in the monitor: the `layer` mask kind (MK8.2).
 *
 * The twin of `engine/python/framepilot_engine/render/layer_mattes.py`. A layer mask cuts a clip
 * by ANOTHER picture: the source clip (or every picture on the source track) composited alone on
 * a transparent frame at the same instant — the frame plan's own layers for it, marked
 * `matteOnly` so the compositor renders them for the matte and never draws them itself.
 *
 * The compositor builds that source frame on the GPU with its ordinary passes, then
 * {@link MASK_LAYER_FRAGMENT} reads it at the frame pixel each of the clip's (cropped, not yet
 * resized) pixel centres lands on — the engine's expressions, in the engine's order:
 *
 *     u = ((col + 0.5) * width) / localWidth,  v likewise
 *     X = x + u                               (no rotation)
 *     X = x + hx + (du·cos + dv·sin),  Y = y + hy + (dv·cos − du·sin)   (PIL's CCW turn)
 *
 * and takes `(floor(X), floor(Y))`. The channel is the source's alpha or its Rec. 709 luma over
 * transparent black, inverted AFTER sampling for the `inverted-*` channels (nothing there reads
 * as 1). Then the same finesse passes and tail a `key` runs (`gl/alpha-passes.ts`).
 *
 * A fragment shader is float32, so the monitor cannot be byte-equal to the float64 export; the
 * CPU twin here ({@link layerMatteAlpha}) IS, and is pinned to the engine by
 * `tests/fixtures/mask-raster/layer.json`, while the shader is judged by the PX4 oracle's
 * `alpha/layer-*` rows at the unchanged gates.
 */
import type { MaskLayer } from '@framepilot/timeline-schema';

import { keyMorphExceedsPass } from './key-mask.js';

/** A `layer` mask. */
export type LayerMask = Extract<MaskLayer, { kind: 'layer' }>;

/** The channels, in the order {@link MASK_LAYER_FRAGMENT} numbers them (`LAYER_CHANNELS`). */
export const LAYER_CHANNELS = ['alpha', 'luma', 'inverted-alpha', 'inverted-luma'] as const;

/** Rec. 709 luma, the key's and the effect passes' coefficients (`LUMA_COEFFICIENTS`). */
const LUMA = [0.2126, 0.7152, 0.0722] as const;

/**
 * Where a clip's masked (cropped) picture lands on the frame (`PicturePlacement`): its raster,
 * the size it is resized to, PIL's counter-clockwise rotation in degrees, the integer paste.
 */
export interface PicturePlacement {
  readonly localWidth: number;
  readonly localHeight: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
}

/** Whether a stack holds a track matte, so it must be built on the GPU from its source frame. */
export function stackReadsLayers(masks: readonly MaskLayer[]): boolean {
  return masks.some((mask) => mask.kind === 'layer');
}

/**
 * `assert_layer_drawable` (and the key's morphology cap): why the monitor cannot draw a track
 * matte, or `null`. A track matte takes its edge from its source, so expansion and feathers are
 * refused; the finesse morphology runs as the key's shader passes, capped at 16 px.
 */
export function layerMatteRefusal(mask: LayerMask): string | null {
  if (mask.featherModel === 'gaussian-legacy') {
    return "A mask uses the legacy blur feather, which only migrated shapes have. Switch the mask's feather model to Distance.";
  }
  if (
    mask.expansionPx !== 0 ||
    mask.featherInnerPx !== 0 ||
    mask.featherOuterPx !== 0 ||
    mask.keyframes.some((keyframe) =>
      ['expansionPx', 'featherInnerPx', 'featherOuterPx'].includes(keyframe.property),
    )
  ) {
    return 'A track matte has expansion or feather set, and a track matte takes its edge from its source. Set them to 0 and use the finesse controls to grow or soften it.';
  }
  if (keyMorphExceedsPass(mask as unknown as Parameters<typeof keyMorphExceedsPass>[0])) {
    return 'The monitor cannot preview a matte morphology this wide. Reduce open, close or shrink/grow to 16 px or less.';
  }
  return null;
}

/** `sample_positions` for one local pixel: the frame pixel its centre lands on. */
export function layerSamplePosition(
  placement: PicturePlacement,
  col: number,
  row: number,
): readonly [number, number] {
  const u = ((col + 0.5) * placement.width) / placement.localWidth;
  const v = ((row + 0.5) * placement.height) / placement.localHeight;
  if (placement.rotation === 0) {
    return [Math.floor(placement.x + u), Math.floor(placement.y + v)];
  }
  const radians = (placement.rotation * Math.PI) / 180.0;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const hx = placement.width * 0.5;
  const hy = placement.height * 0.5;
  const du = u - hx;
  const dv = v - hy;
  return [
    Math.floor(placement.x + hx + (du * cos + dv * sin)),
    Math.floor(placement.y + hy + (dv * cos - du * sin)),
  ];
}

/**
 * The CPU twin of the shader and `sampled_channel` (float64, byte-exact with the engine): the
 * channel of an RGBA frame (straight alpha, 8-bit) on a clip's local raster, BEFORE finesse,
 * invert and opacity.
 */
export function layerMatteAlpha(
  frame: { readonly width: number; readonly height: number; readonly rgba: Uint8Array },
  channel: LayerMask['channel'],
  placement: PicturePlacement,
): Float64Array {
  const out = new Float64Array(placement.localWidth * placement.localHeight);
  const luma = channel === 'luma' || channel === 'inverted-luma';
  const inverted = channel === 'inverted-alpha' || channel === 'inverted-luma';
  for (let row = 0; row < placement.localHeight; row += 1) {
    for (let col = 0; col < placement.localWidth; col += 1) {
      const [x, y] = layerSamplePosition(placement, col, row);
      let value = 0.0;
      if (x >= 0 && y >= 0 && x < frame.width && y < frame.height) {
        const at = (y * frame.width + x) * 4;
        const alpha = frame.rgba[at + 3]! / 255.0;
        if (luma) {
          // `luma_of` accumulates left to right: r * cr + g * cg + b * cb.
          const lum =
            (frame.rgba[at]! / 255.0) * LUMA[0] +
            (frame.rgba[at + 1]! / 255.0) * LUMA[1] +
            (frame.rgba[at + 2]! / 255.0) * LUMA[2];
          value = lum * alpha;
        } else {
          value = alpha;
        }
      }
      out[row * placement.localWidth + col] = inverted ? 1.0 - value : value;
    }
  }
  return out;
}

/** The uniforms {@link MASK_LAYER_FRAGMENT} reads. */
export interface LayerMatteUniforms {
  readonly local: readonly [number, number];
  readonly resized: readonly [number, number];
  readonly offset: readonly [number, number];
  readonly rotated: number;
  readonly rotation: readonly [number, number];
  readonly channel: number;
}

/** The shader's uniforms for a placement and channel (cos/sin once, in float64). */
export function layerMatteUniforms(
  placement: PicturePlacement,
  channel: LayerMask['channel'],
): LayerMatteUniforms {
  const radians = (placement.rotation * Math.PI) / 180.0;
  return {
    local: [placement.localWidth, placement.localHeight],
    resized: [placement.width, placement.height],
    offset: [placement.x, placement.y],
    rotated: placement.rotation === 0 ? 0 : 1,
    rotation: [Math.cos(radians), Math.sin(radians)],
    channel: LAYER_CHANNELS.indexOf(channel),
  };
}

/**
 * The track matte pass: the source frame (`rgba8`, rows top first, straight alpha) sampled onto
 * the clip's local raster, into the `.r` of a float target the finesse passes read.
 */
export const MASK_LAYER_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_matte;
uniform ivec2 u_frameSize;
uniform vec2 u_local;
uniform vec2 u_resized;
uniform vec2 u_offset;
uniform int u_rotated;
uniform vec2 u_rotation;
uniform int u_channel;
out vec4 o_color;
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float u = ((p.x + 0.5) * u_resized.x) / u_local.x;
  float v = ((p.y + 0.5) * u_resized.y) / u_local.y;
  float fx;
  float fy;
  if (u_rotated == 0) {
    fx = u_offset.x + u;
    fy = u_offset.y + v;
  } else {
    float hx = u_resized.x * 0.5;
    float hy = u_resized.y * 0.5;
    float du = u - hx;
    float dv = v - hy;
    fx = u_offset.x + hx + (du * u_rotation.x + dv * u_rotation.y);
    fy = u_offset.y + hy + (dv * u_rotation.x - du * u_rotation.y);
  }
  ivec2 q = ivec2(floor(fx), floor(fy));
  float value = 0.0;
  if (q.x >= 0 && q.y >= 0 && q.x < u_frameSize.x && q.y < u_frameSize.y) {
    vec4 texel = texelFetch(u_matte, q, 0);
    float alpha = floor(texel.a * 255.0 + 0.5) / 255.0;
    if (u_channel == 1 || u_channel == 3) {
      vec3 rgb = floor(texel.rgb * 255.0 + 0.5) / 255.0;
      value = (rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722) * alpha;
    } else {
      value = alpha;
    }
  }
  if (u_channel >= 2) value = 1.0 - value;
  o_color = vec4(value, 0.0, 0.0, 1.0);
}`;
