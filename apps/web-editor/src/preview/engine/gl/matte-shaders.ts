/**
 * Fragment shaders for a `matte` mask layer on the GPU (PX5.3): `render/matte_edges.py` pass by
 * pass, after the shared finesse chain (`alpha-passes.ts`).
 *
 * WHY shaders: the float64 twin (`masks/matte-edges.ts`) costs 452 ms of main thread per
 * composite for a 4K matte (`plan/background-removal-ai/PX5-BUDGETS.md`), so the monitor froze.
 * A GPU is float32 and cannot be byte-equal to the export's float64; like the `key` passes, each
 * formula here is evaluated in the export's own order (taps summed one by one from the first,
 * `a + (b - a) * t`, integer distances, one `sqrt`, round-half-even), so the residual is float32
 * rounding and the PX4 oracle judges it at its unchanged gates.
 *
 * Every texture is addressed with `texelFetch` at integer coordinates, rows top first, as every
 * other mask pass is: there is no filtering and no normalised coordinate anywhere.
 */
import { ALPHA_LEVELS_GLSL } from '../../masks/key-mask.js';
import { FALLOFF_TABLE_SIZE } from '../../masks/mask-raster.js';
import { TIER_COLOUR_SCALE, TIER_WEIGHT_SCALE } from '../../masks/matte-edges.js';
import { MAX_TAPS } from './raster-shaders.js';

/**
 * Widest distance-feather cap one pass carries (`ceil(widest) + 2` source pixels). Above it the
 * compositor draws the layer with the exact CPU twin instead, so nothing is refused or clipped.
 */
export const MAX_MATTE_FEATHER_CAP = 96;

/**
 * The gaussian falloff table is uploaded as a square of this side: WebGL2 only guarantees
 * 2048-texel textures, and the table has {@link FALLOFF_TABLE_SIZE} (4096) entries.
 */
export const FALLOFF_TABLE_SIDE = 64;
if (FALLOFF_TABLE_SIDE * FALLOFF_TABLE_SIDE !== FALLOFF_TABLE_SIZE) {
  throw new Error('The falloff table no longer fills its square texture.');
}

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
`;

/** `alpha_int / maximum`: the decoded matte samples as float alpha. */
export const MATTE_TO_FLOAT_FRAGMENT = `${HEADER}
uniform usampler2D u_matte;
uniform float u_maximum;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o_color = vec4(float(texelFetch(u_matte, p, 0).r) / u_maximum, 0.0, 0.0, 1.0);
}`;

/**
 * PX5.3: a matte whose source-pixel chain is POINTWISE (no edge shift, feather, denoise,
 * morphology or blur: only clean levels and in/out ratio, as `edgeMode: 'sharp'` and the
 * defaults are) resampled across straight from its integer samples, the chain applied per tap.
 *
 * WHY: otherwise the artifact's whole 4K plane goes through two or three float passes (to-float,
 * levels, ratio), each writing a 33 MB target, before the resample reads it. Per tap this is
 * the same float operations as those passes (`x / maximum`, then {@link ALPHA_LEVELS_GLSL}; a
 * float32 target stores each intermediate exactly), then the same tap sum as
 * {@link MATTE_RESAMPLE_FRAGMENT}, so the values are the unfused path's. `u_tapCount == 0` is
 * an identity axis: the chain at the artifact's own width.
 */
export const MATTE_ALPHA_ACROSS_FRAGMENT = `${HEADER}
uniform usampler2D u_matte;
uniform sampler2D u_taps;
uniform int u_tapCount;
uniform float u_maximum;
${ALPHA_LEVELS_GLSL}
out vec4 o_color;
float sampleAt(ivec2 q) {
  return alphaLevels(float(texelFetch(u_matte, q, 0).r) / u_maximum);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (u_tapCount == 0) {
    o_color = vec4(sampleAt(p), 0.0, 0.0, 1.0);
    return;
  }
  int limit = textureSize(u_matte, 0).x - 1;
  int first = int(texelFetch(u_taps, ivec2(0, p.x), 0).r);
  float total = 0.0;
  for (int tap = 0; tap < ${String(MAX_TAPS)}; tap++) {
    if (tap >= u_tapCount) break;
    float value = sampleAt(ivec2(clamp(first + tap, 0, limit), p.y));
    float weight = texelFetch(u_taps, ivec2(tap + 1, p.x), 0).r;
    total = tap == 0 ? value * weight : total + value * weight;
  }
  o_color = vec4(clamp(total, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/**
 * `_row_distance` for both feature sets at once: the column distance to the nearest INSIDE pixel
 * (`alpha >= 0.5`) and to the nearest OUTSIDE pixel in this row, each capped. Both are small
 * integers, so they share one float channel as `inside + 256 * outside`, exactly.
 */
export const MATTE_ROW_DISTANCE_FRAGMENT = `${HEADER}
uniform sampler2D u_alpha;
uniform int u_cap;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int width = textureSize(u_alpha, 0).x;
  int toInside = u_cap;
  int toOutside = u_cap;
  for (int d = 0; d < ${String(MAX_MATTE_FEATHER_CAP)}; d++) {
    if (d >= u_cap || (toInside < u_cap && toOutside < u_cap)) break;
    if (p.x - d >= 0) {
      bool inside = texelFetch(u_alpha, ivec2(p.x - d, p.y), 0).r >= 0.5;
      if (inside) toInside = min(toInside, d); else toOutside = min(toOutside, d);
    }
    if (p.x + d < width) {
      bool inside = texelFetch(u_alpha, ivec2(p.x + d, p.y), 0).r >= 0.5;
      if (inside) toInside = min(toInside, d); else toOutside = min(toOutside, d);
    }
  }
  o_color = vec4(float(toInside + 256 * toOutside), 0.0, 0.0, 1.0);
}`;

/**
 * `_bounded_distance` down the columns, then `distance_feather`: the squared distance is the
 * minimum over row offsets of `row² + dy²` in integers (exact in float32 far past the cap), one
 * `sqrt`, then the shape rasteriser's formula and falloff. A pixel only needs the distance to
 * the OTHER side of the contour, so only that one is searched.
 */
export const MATTE_FEATHER_FRAGMENT = `${HEADER}
uniform sampler2D u_alpha;
uniform sampler2D u_rows;
uniform sampler2D u_table;
uniform int u_cap;
uniform float u_expansion;
uniform float u_inner;
uniform float u_outer;
/** 0 linear, 1 smooth, 2 gaussian (the shipped table). */
uniform int u_falloff;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int height = textureSize(u_alpha, 0).y;
  bool inside = texelFetch(u_alpha, p, 0).r >= 0.5;
  float capped = float(u_cap * u_cap);
  float best = capped;
  for (int dy = -${String(MAX_MATTE_FEATHER_CAP)}; dy <= ${String(MAX_MATTE_FEATHER_CAP)}; dy++) {
    if (dy < -u_cap || dy > u_cap) continue;
    int y = p.y + dy;
    if (y < 0 || y >= height) continue;
    float pair = texelFetch(u_rows, ivec2(p.x, y), 0).r;
    float toOutside = floor(pair / 256.0);
    float row = inside ? toOutside : pair - 256.0 * toOutside;
    best = min(best, row * row + float(dy * dy));
  }
  float reach = sqrt(best);
  float signedDistance = inside ? 0.5 - reach : reach - 0.5;
  float shifted = signedDistance - u_expansion;
  float total = u_inner + u_outer;
  float x = clamp(total <= 0.0 ? 0.5 - shifted : (u_outer - shifted) / total, 0.0, 1.0);
  float alpha = x;
  if (u_falloff == 1) alpha = x * x * (3.0 - 2.0 * x);
  else if (u_falloff == 2) {
    float position = x * ${String(FALLOFF_TABLE_SIZE - 1)}.0;
    int index = min(int(floor(position)), ${String(FALLOFF_TABLE_SIZE - 2)});
    int next = index + 1;
    float low = texelFetch(u_table, ivec2(index % ${String(FALLOFF_TABLE_SIDE)}, index / ${String(FALLOFF_TABLE_SIDE)}), 0).r;
    float high = texelFetch(u_table, ivec2(next % ${String(FALLOFF_TABLE_SIDE)}, next / ${String(FALLOFF_TABLE_SIDE)}), 0).r;
    alpha = low + (high - low) * (position - float(index));
  }
  o_color = vec4(alpha, 0.0, 0.0, 1.0);
}`;

/**
 * `_resample_axis`: the engine's bicubic along one axis, every channel, clamped to
 * `[0, u_ceiling]`. `u_taps` is `(taps + 1) × size`: column 0 the first source index (before
 * clamping, so it may be negative), columns 1.. the float64-normalised weights
 * (`resampleTaps`). Taps are accumulated one by one from the first, as the engine sums them.
 */
export const MATTE_RESAMPLE_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform sampler2D u_taps;
uniform int u_tapCount;
/** 0 across (output x indexes the table), 1 down. */
uniform int u_axis;
uniform vec4 u_ceiling;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_source, 0);
  int row = u_axis == 0 ? p.x : p.y;
  int limit = (u_axis == 0 ? size.x : size.y) - 1;
  int first = int(texelFetch(u_taps, ivec2(0, row), 0).r);
  vec4 total = vec4(0.0);
  for (int tap = 0; tap < ${String(MAX_TAPS)}; tap++) {
    if (tap >= u_tapCount) break;
    int index = clamp(first + tap, 0, limit);
    vec4 value = texelFetch(u_source, u_axis == 0 ? ivec2(index, p.y) : ivec2(p.x, index), 0);
    float weight = texelFetch(u_taps, ivec2(tap + 1, row), 0).r;
    total = tap == 0 ? value * weight : total + value * weight;
  }
  o_color = clamp(total, vec4(0.0), u_ceiling);
}`;

/**
 * The decontamination planes from the lossless masters, resampled ACROSS in the same pass:
 * `band = 0 < alpha < maximum`, colour premultiplied by the band (RGB) and the band weight (A).
 * Folding the band into the horizontal pass means no artifact-sized RGBA float target exists
 * (132 MB at 4K). `u_tapCount == 0` is the engine's identity: the planes at their own width.
 */
export const MATTE_BAND_FRAGMENT = `${HEADER}
uniform usampler2D u_matte;
uniform usampler2D u_foreground;
uniform sampler2D u_taps;
uniform int u_tapCount;
uniform uint u_maximum;
out vec4 o_color;
vec4 planes(ivec2 q) {
  uint alpha = texelFetch(u_matte, q, 0).r;
  float band = alpha > 0u && alpha < u_maximum ? 1.0 : 0.0;
  return vec4(vec3(texelFetch(u_foreground, q, 0).rgb) * band, band);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (u_tapCount == 0) {
    o_color = planes(p);
    return;
  }
  int limit = textureSize(u_matte, 0).x - 1;
  int first = int(texelFetch(u_taps, ivec2(0, p.x), 0).r);
  vec4 total = vec4(0.0);
  for (int tap = 0; tap < ${String(MAX_TAPS)}; tap++) {
    if (tap >= u_tapCount) break;
    vec4 value = planes(ivec2(clamp(first + tap, 0, limit), p.y));
    float weight = texelFetch(u_taps, ivec2(tap + 1, p.x), 0).r;
    total = tap == 0 ? value * weight : total + value * weight;
  }
  o_color = clamp(total, vec4(0.0), vec4(255.0, 255.0, 255.0, 1.0));
}`;

/**
 * PX5.3: the monitor tier's planes (`render/matte_tier.py`) as the float planes
 * {@link MATTE_DECONTAMINATE_FRAGMENT} reads: one `W × 8H` byte texture, rows top first, each
 * 16-bit plane (weight, R, G, B) as its high-byte then its low-byte rows, to
 * `vec4(colour, weight)` at `W × H`. The integers are rebuilt exactly (`hi * 256 + lo`) before
 * the one division. The tier is already at the decoded size, so this replaces the band pass and
 * the resample to it; the crop follows as for the masters.
 */
export const MATTE_TIER_PLANES_FRAGMENT = `${HEADER}
uniform usampler2D u_planes;
uniform int u_height;
out vec4 o_color;
uint planeValue(ivec2 p, int plane) {
  uint high = texelFetch(u_planes, ivec2(p.x, p.y + 2 * plane * u_height), 0).r;
  uint low = texelFetch(u_planes, ivec2(p.x, p.y + (2 * plane + 1) * u_height), 0).r;
  return high * 256u + low;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float weight = float(planeValue(p, 0)) / ${String(TIER_WEIGHT_SCALE)}.0;
  vec3 colour = vec3(float(planeValue(p, 1)), float(planeValue(p, 2)), float(planeValue(p, 3)));
  o_color = vec4(colour / ${String(TIER_COLOUR_SCALE)}.0, weight);
}`;

/** The clip's integer crop (`_crop_slices`), then optionally `layer_alpha` (invert, opacity). */
export const MATTE_CROP_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform ivec2 u_origin;
/** 1 applies invert and opacity to the first channel; 0 copies every channel. */
uniform int u_layer;
uniform float u_invert;
uniform float u_opacity;
out vec4 o_color;
void main() {
  vec4 value = texelFetch(u_source, ivec2(gl_FragCoord.xy) + u_origin, 0);
  if (u_layer == 1) {
    o_color = vec4((u_invert == 1.0 ? 1.0 - value.r : value.r) * u_opacity, 0.0, 0.0, 1.0);
  } else {
    o_color = value;
  }
}`;

/**
 * `decontaminate`: `out = rint(picture + (colour - picture * weight))`, RGB only, the picture's
 * alpha kept. The picture's bytes are recovered exactly from its normalised texels, and the
 * result is rounded half-even (numpy `rint`) back to bytes here, because the export quantises
 * at this step too: every later effect reads 8-bit colour on both sides.
 */
export const MATTE_DECONTAMINATE_FRAGMENT = `${HEADER}
uniform sampler2D u_picture;
uniform sampler2D u_planes;
uniform ivec2 u_origin;
out vec4 o_color;
float roundHalfEven(float value) {
  float low = floor(value);
  float fraction = value - low;
  if (fraction > 0.5) return low + 1.0;
  if (fraction < 0.5) return low;
  return mod(low, 2.0) == 0.0 ? low : low + 1.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 picture = texelFetch(u_picture, p, 0);
  vec4 planes = texelFetch(u_planes, p + u_origin, 0);
  vec3 base = floor(picture.rgb * 255.0 + 0.5);
  vec3 mixed = base + (planes.rgb - base * planes.a);
  vec3 rounded = clamp(vec3(roundHalfEven(mixed.r), roundHalfEven(mixed.g), roundHalfEven(mixed.b)), 0.0, 255.0);
  o_color = vec4(rounded / 255.0, picture.a);
}`;
