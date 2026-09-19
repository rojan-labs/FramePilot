/**
 * The `key` mask kind in the preview (MK6.1): the GLSL twin of
 * `engine/python/framepilot_engine/render/key_mask.py`, plus the CPU version the eyedropper and
 * the parity harness use.
 *
 * WHY A SHADER, when every other mask kind is rastered on the CPU: a key reads the PICTURE, not
 * geometry. Every pixel of every frame has to be qualified, so the CPU rasteriser's cache — draw
 * once, reuse while nothing moves — buys nothing, and a per-frame read-back of a 4K picture into
 * JavaScript would cost more than the whole composite. The pass runs on the decoded RGB the
 * compositor already holds, which PX2.7 decoded with the export's own colour matrix and range,
 * so both sides qualify the same numbers.
 *
 * WHY THE GATE IS 1/255 AND NOT BYTE-EQUALITY, unlike the shape rasteriser: a fragment shader is
 * float32 with no control over the order of a `length()` or a division. Every formula below is
 * therefore written to be evaluated the same way in both languages — polynomials, one `sqrt`, no
 * tables, no `pow` — and the residual is float32 rounding, which the plan's 1/255 covers.
 *
 * WHICH WAY IT POINTS: the alpha is how much the pixel MATCHES. A green screen is keyed by
 * selecting the green and setting the mask's `invert`, exactly as a shape cut-out is inverted.
 */
import type { MaskLayer } from '@framepilot/timeline-schema';

export type KeyMask = Extract<MaskLayer, { kind: 'key' }>;

/** Rec. 709 luma, the coefficients the engine and the effect passes share. */
export const LUMA_COEFFICIENTS = [0.2126, 0.7152, 0.0722] as const;

/** Channel order the shader indexes by; the schema's enum in this order. */
export const KEY_CHANNELS = ['hue', 'saturation', 'luma', 'red', 'green', 'blue'] as const;

/**
 * How many ranges and samples one pass carries.
 *
 * A qualifier has at most one range per channel, and an eyedropper that has taken more than a
 * handful of samples is describing a region, not a colour — but the schema caps neither, so a
 * mask beyond this refuses in the monitor rather than keying on a silently truncated list.
 */
export const MAX_KEY_RANGES = 8;
export const MAX_KEY_SAMPLES = 8;

/** Uniform payload for one key pass; the numbers the shader reads, packed once per frame. */
export interface KeyUniforms {
  /** 0 = ranges (`hsl`, `rgb`, `luma`), 1 = sampled colours (`3d`). */
  readonly sampled: number;
  readonly rangeCount: number;
  /** Per range, `(low, high, effectiveSoftness, channelIndex)`. */
  readonly ranges: Float32Array;
  readonly sampleCount: number;
  /** Per sample, `(r, g, b, 0)`. */
  readonly samples: Float32Array;
  readonly tolerance: number;
  readonly shadowRetention: number;
  readonly cleanBlack: number;
  readonly cleanWhite: number;
  readonly invert: number;
  readonly opacity: number;
  /** The finesse group's in/out ratio, applied after the raster steps and before the layer. */
  readonly inOutRatio: number;
}

/** `qualifier` + `sample_qualifier`: the mask's numbers flattened for the shader. */
export function keyUniforms(mask: KeyMask, opacity: number): KeyUniforms {
  const extra = Math.max(mask.softness, 0);
  const ranges = new Float32Array(MAX_KEY_RANGES * 4);
  const used = mask.ranges.slice(0, MAX_KEY_RANGES);
  used.forEach((entry, index) => {
    ranges[index * 4] = entry.low;
    ranges[index * 4 + 1] = entry.high;
    ranges[index * 4 + 2] = Math.max(entry.softness, 0) + extra;
    ranges[index * 4 + 3] = KEY_CHANNELS.indexOf(entry.channel);
  });
  const samples = new Float32Array(MAX_KEY_SAMPLES * 4);
  const picked = mask.samples3d.slice(0, MAX_KEY_SAMPLES);
  picked.forEach((sample, index) => {
    samples[index * 4] = sample[0];
    samples[index * 4 + 1] = sample[1];
    samples[index * 4 + 2] = sample[2];
  });
  return {
    sampled: mask.model === '3d' ? 1 : 0,
    rangeCount: mask.model === '3d' ? 0 : used.length,
    ranges,
    sampleCount: mask.model === '3d' ? picked.length : 0,
    samples,
    tolerance: Math.max(mask.softness, 0),
    shadowRetention: Math.max(mask.shadowRetention, 0),
    cleanBlack: mask.finesse.cleanBlack,
    cleanWhite: mask.finesse.cleanWhite,
    invert: mask.invert ? 1 : 0,
    opacity: opacity <= 0 ? 0 : opacity >= 1 ? 1 : opacity,
    inOutRatio: mask.finesse.inOutRatio,
  };
}

/**
 * Every enabled key in a stack asking for despill, top first (`despilling_keys`).
 *
 * Both targets are walked: a key limiting an effect still spills into the picture, and the
 * limiter is a picture correction, not an alpha one.
 */
export function despillingKeys(
  stack: {
    readonly alpha: readonly MaskLayer[];
    readonly byEffect: ReadonlyMap<string, readonly MaskLayer[]>;
  } | null,
): readonly KeyMask[] {
  if (stack === null) return [];
  const all = [...stack.alpha, ...[...stack.byEffect.values()].flat()];
  return all.filter((mask): mask is KeyMask => mask.kind === 'key' && mask.despill !== 'none');
}

/** Whether a key carries more ranges or samples than one pass can hold. */
export function keyExceedsPass(mask: KeyMask): boolean {
  return mask.ranges.length > MAX_KEY_RANGES || mask.samples3d.length > MAX_KEY_SAMPLES;
}

// --- The CPU twin (the eyedropper and the parity harness) -------------------------------------

const smoothstepAt = (x: number): number => x * x * (3 - 2 * x);
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** JavaScript `%` keeps the sign of the dividend; Python's and GLSL's `mod` do not. */
const wrap1 = (x: number): number => x - Math.floor(x);
const mod6 = (x: number): number => x - Math.floor(x / 6) * 6;

/** `channel_values` for one pixel, in the shader's channel order. */
export function channelValues(r: number, g: number, b: number): number[] {
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const span = maximum - minimum;
  const safe = span > 0 ? span : 1;
  let sector: number;
  if (maximum === r) sector = mod6((g - b) / safe);
  else if (maximum === g) sector = (b - r) / safe + 2;
  else sector = (r - g) / safe + 4;
  const hue = span > 0 ? sector / 6 : 0;
  const saturation = maximum > 0 ? span / maximum : 0;
  const luma = r * LUMA_COEFFICIENTS[0] + g * LUMA_COEFFICIENTS[1] + b * LUMA_COEFFICIENTS[2];
  return [hue, saturation, luma, r, g, b];
}

/** `range_membership`: 1 inside, 0 beyond the softness band, smoothstep across it. */
export function rangeMembership(
  value: number,
  low: number,
  high: number,
  softness: number,
  circular: boolean,
): number {
  let distance: number;
  if (circular) {
    const inside = low <= high ? value >= low && value <= high : value >= low || value <= high;
    distance = inside ? 0 : Math.min(wrap1(low - value), wrap1(value - high));
  } else {
    distance = Math.max(Math.max(low - value, value - high), 0);
  }
  if (softness <= 0) return distance <= 0 ? 1 : 0;
  return smoothstepAt(clamp01(1 - distance / softness));
}

/** `in_out_ratio` for one value: two straight segments through a moved midpoint. */
export function applyInOutRatio(alpha: number, ratio: number): number {
  if (ratio === 0) return alpha;
  const clamped = Math.min(1, Math.max(-1, ratio));
  const mid = 0.5 - clamped * 0.5;
  if (mid <= 0) return alpha > 0 ? 1 : 0;
  if (mid >= 1) return alpha >= 1 ? 1 : 0;
  const mapped = alpha <= mid ? (alpha * 0.5) / mid : 0.5 + ((alpha - mid) * 0.5) / (1 - mid);
  return clamp01(mapped);
}

/** `apply_clean_levels` for one value. */
export function applyCleanLevel(alpha: number, black: number, white: number): number {
  if (black === 0 && white === 1) return alpha;
  if (white <= black) return alpha >= black ? 1 : 0;
  return clamp01((alpha - black) / (white - black));
}

/**
 * The POINTWISE key chain for one RGB triple, in `[0, 1]`: the qualifier, shadow retention,
 * clean levels, the in/out ratio, then invert and opacity.
 *
 * The same arithmetic the shader runs, in float64. Used by the eyedropper (to show what a
 * sampled colour would key) and by the parity harness as the reference the shader is measured
 * against. The finesse controls that read NEIGHBOURING pixels — denoise, the morphology, the
 * blur — are not here by definition: one colour has no neighbours. Those run as raster steps,
 * on the CPU for a matte and as shader passes for a key.
 */
export function keyAlphaAt(uniforms: KeyUniforms, r: number, g: number, b: number): number {
  const channels = channelValues(r, g, b);
  const luma = channels[2]!;
  let matched: number;
  if (uniforms.sampled === 1) {
    matched = 0;
    for (let index = 0; index < uniforms.sampleCount; index += 1) {
      const dr = r - uniforms.samples[index * 4]!;
      const dg = g - uniforms.samples[index * 4 + 1]!;
      const db = b - uniforms.samples[index * 4 + 2]!;
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);
      const term =
        uniforms.tolerance <= 0
          ? distance <= 0
            ? 1
            : 0
          : smoothstepAt(clamp01(2 - distance / uniforms.tolerance));
      matched = Math.max(matched, term);
    }
  } else if (uniforms.rangeCount === 0) {
    matched = 0;
  } else {
    matched = 1;
    for (let index = 0; index < uniforms.rangeCount; index += 1) {
      const low = uniforms.ranges[index * 4]!;
      const high = uniforms.ranges[index * 4 + 1]!;
      const softness = uniforms.ranges[index * 4 + 2]!;
      const channel = uniforms.ranges[index * 4 + 3]!;
      matched *= rangeMembership(channels[channel]!, low, high, softness, channel === 0);
    }
  }
  if (uniforms.shadowRetention > 0) {
    matched *= smoothstepAt(clamp01(luma / uniforms.shadowRetention));
  }
  matched = applyCleanLevel(clamp01(matched), uniforms.cleanBlack, uniforms.cleanWhite);
  matched = applyInOutRatio(matched, uniforms.inOutRatio);
  return (uniforms.invert === 1 ? 1 - matched : matched) * uniforms.opacity;
}

// --- The shader -------------------------------------------------------------------------------

/**
 * The key pass: a normalised RGB picture in, the layer's alpha out in `.r` of a float target.
 *
 * Every line has a named counterpart in `key_mask.py`; they are changed together.
 */
export const MASK_KEY_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_picture;
uniform int u_sampled;
uniform int u_rangeCount;
uniform vec4 u_ranges[${String(MAX_KEY_RANGES)}];
uniform int u_sampleCount;
uniform vec4 u_samples[${String(MAX_KEY_SAMPLES)}];
uniform float u_tolerance;
uniform float u_shadow;
out vec4 o_color;

float sm(float x) { return x * x * (3.0 - 2.0 * x); }

// channel_values(): hue, saturation (HSV), Rec.709 luma, then the raw channels.
void channels(vec3 rgb, out float hue, out float sat, out float lum) {
  float maxc = max(max(rgb.r, rgb.g), rgb.b);
  float minc = min(min(rgb.r, rgb.g), rgb.b);
  float span = maxc - minc;
  float safe = span > 0.0 ? span : 1.0;
  float sector;
  if (maxc == rgb.r) sector = mod((rgb.g - rgb.b) / safe, 6.0);
  else if (maxc == rgb.g) sector = (rgb.b - rgb.r) / safe + 2.0;
  else sector = (rgb.r - rgb.g) / safe + 4.0;
  hue = span > 0.0 ? sector / 6.0 : 0.0;
  sat = maxc > 0.0 ? span / maxc : 0.0;
  lum = rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722;
}

float channelValue(int index, vec3 rgb, float hue, float sat, float lum) {
  if (index == 0) return hue;
  if (index == 1) return sat;
  if (index == 2) return lum;
  if (index == 3) return rgb.r;
  if (index == 4) return rgb.g;
  return rgb.b;
}

// range_membership(): hue measures on the circle, every other axis is plain.
float membership(float value, float low, float high, float softness, bool circular) {
  float distance;
  if (circular) {
    bool inside = low <= high ? (value >= low && value <= high) : (value >= low || value <= high);
    distance = inside ? 0.0 : min(mod(low - value, 1.0), mod(value - high, 1.0));
  } else {
    distance = max(max(low - value, value - high), 0.0);
  }
  if (softness <= 0.0) return distance <= 0.0 ? 1.0 : 0.0;
  return sm(clamp(1.0 - distance / softness, 0.0, 1.0));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 rgb = texelFetch(u_picture, p, 0).rgb;
  float hue; float sat; float lum;
  channels(rgb, hue, sat, lum);
  float matched;
  if (u_sampled == 1) {
    // sample_qualifier(): a tolerance sphere per sample, unioned with max.
    matched = 0.0;
    for (int i = 0; i < ${String(MAX_KEY_SAMPLES)}; i++) {
      if (i >= u_sampleCount) break;
      vec3 d = rgb - u_samples[i].rgb;
      float distance = sqrt(d.r * d.r + d.g * d.g + d.b * d.b);
      float term = u_tolerance <= 0.0
        ? (distance <= 0.0 ? 1.0 : 0.0)
        : sm(clamp(2.0 - distance / u_tolerance, 0.0, 1.0));
      matched = max(matched, term);
    }
  } else if (u_rangeCount == 0) {
    // An unfinished qualifier matches nothing, so the mask looks unfinished.
    matched = 0.0;
  } else {
    matched = 1.0;
    for (int i = 0; i < ${String(MAX_KEY_RANGES)}; i++) {
      if (i >= u_rangeCount) break;
      int channel = int(u_ranges[i].w);
      float value = channelValue(channel, rgb, hue, sat, lum);
      matched *= membership(value, u_ranges[i].x, u_ranges[i].y, u_ranges[i].z, channel == 0);
    }
  }
  // apply_shadow_retention(): dark pixels come back out of the key.
  if (u_shadow > 0.0) matched *= sm(clamp(lum / u_shadow, 0.0, 1.0));
  // The qualifier stops here. The finesse group cleans this alpha up and layer_alpha inverts
  // and scales it, in that order, exactly as key_mask_alpha chains them.
  o_color = vec4(clamp(matched, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/** The despill limiter, applied to the picture where the engine's `despill` applies it. */
export const MASK_DESPILL_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_picture;
/** 1 = green, 2 = blue. */
uniform int u_colour;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 texel = texelFetch(u_picture, p, 0);
  vec3 rgb = texel.rgb;
  if (u_colour == 1) rgb.g = min(rgb.g, (rgb.r + rgb.b) * 0.5);
  else if (u_colour == 2) rgb.b = min(rgb.b, (rgb.r + rgb.g) * 0.5);
  o_color = vec4(floor(rgb * 255.0 + 0.5) / 255.0, texel.a);
}`;

// --- The matte finesse group on the GPU (MK6.2) ------------------------------------------------
//
// The same chain `apply_finesse` runs in numpy, as passes over the key's float alpha:
//
//   denoise → clean black/white → morph open → morph close → shrink/grow → blur → in/out ratio
//
// A matte's finesse runs on the CPU in both implementations and is byte-exact; a key's cannot,
// because its alpha only exists on the GPU. These passes are written to evaluate each formula in
// the same order as the numpy one, so the residual is float32 rounding — inside the 1/255 the
// plan's key gate allows.

/**
 * How large a morphology radius one pass carries.
 *
 * A disc of radius r costs (2r+1)² fetches per pixel, so the loop has to be bounded for a
 * shader to compile at all. The cap is 16 px — 1089 fetches at the limit. Above it the monitor
 * refuses with a remedy rather than drawing a smaller disc than the export renders; whether any
 * real matte edge needs more than 16 px has not been measured, so the cap is stated, not
 * justified.
 */
export const MAX_KEY_MORPH_PX = 16;

/** `denoise`: blend toward the 3x3 box mean; edges replicate. */
export const MASK_DENOISE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_alpha;
uniform float u_amount;
out vec4 o_color;
float at(ivec2 size, int x, int y) {
  return texelFetch(u_alpha, ivec2(clamp(x, 0, size.x - 1), clamp(y, 0, size.y - 1)), 0).r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_alpha, 0);
  float rows = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    rows += at(size, p.x - 1, p.y + dy) + at(size, p.x, p.y + dy) + at(size, p.x + 1, p.y + dy);
  }
  float value = at(size, p.x, p.y);
  o_color = vec4(value + (rows / 9.0 - value) * u_amount, 0.0, 0.0, 1.0);
}`;

/**
 * `_disc_morphology` at one integer radius, and the mix of two (`_morphology_at`): the pass is
 * run once per integer radius and the caller mixes, so a fractional radius costs two passes
 * rather than a branch per pixel.
 */
export const MASK_MORPH_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_alpha;
uniform int u_radius;
/** 1 dilates (max), 0 erodes (min). */
uniform int u_grow;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_alpha, 0);
  float best = texelFetch(u_alpha, p, 0).r;
  for (int dy = -${String(MAX_KEY_MORPH_PX)}; dy <= ${String(MAX_KEY_MORPH_PX)}; dy++) {
    if (dy < -u_radius || dy > u_radius) continue;
    for (int dx = -${String(MAX_KEY_MORPH_PX)}; dx <= ${String(MAX_KEY_MORPH_PX)}; dx++) {
      if (dx < -u_radius || dx > u_radius) continue;
      if (dx * dx + dy * dy > u_radius * u_radius) continue;
      ivec2 q = ivec2(clamp(p.x + dx, 0, size.x - 1), clamp(p.y + dy, 0, size.y - 1));
      float value = texelFetch(u_alpha, q, 0).r;
      best = u_grow == 1 ? max(best, value) : min(best, value);
    }
  }
  o_color = vec4(best, 0.0, 0.0, 1.0);
}`;

/** `a + (b - a) * fraction` per pixel: the mix between two integer morphology radii. */
export const MASK_MIX_ALPHA_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_low;
uniform sampler2D u_high;
uniform float u_fraction;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float low = texelFetch(u_low, p, 0).r;
  float high = texelFetch(u_high, p, 0).r;
  o_color = vec4(low + (high - low) * u_fraction, 0.0, 0.0, 1.0);
}`;

/** `_box_pass` along one axis, summed centre-outward as the numpy accumulation is. */
export const MASK_BOX_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_alpha;
uniform int u_radius;
/** 0 horizontal, 1 vertical. */
uniform int u_axis;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_alpha, 0);
  float total = texelFetch(u_alpha, p, 0).r;
  for (int offset = 1; offset <= 64; offset++) {
    if (offset > u_radius) break;
    ivec2 back = u_axis == 0 ? ivec2(p.x - offset, p.y) : ivec2(p.x, p.y - offset);
    ivec2 fore = u_axis == 0 ? ivec2(p.x + offset, p.y) : ivec2(p.x, p.y + offset);
    back = ivec2(clamp(back.x, 0, size.x - 1), clamp(back.y, 0, size.y - 1));
    fore = ivec2(clamp(fore.x, 0, size.x - 1), clamp(fore.y, 0, size.y - 1));
    total += texelFetch(u_alpha, back, 0).r;
    total += texelFetch(u_alpha, fore, 0).r;
  }
  o_color = vec4(total / float(2 * u_radius + 1), 0.0, 0.0, 1.0);
}`;

/**
 * `apply_clean_levels` then `in_out_ratio` on one alpha, as GLSL: the ONE copy of that
 * arithmetic on the GPU. {@link MASK_LEVELS_FRAGMENT} runs it as a pass; a matte whose source
 * chain is only these two runs it per tap inside its resample (PX5.3, `matte-shaders.ts`), and
 * both must stay the same float operations in the same order.
 */
export const ALPHA_LEVELS_GLSL = `
/** 1 applies the clean levels (they run before the morphology, so usually 0 in a tail pass). */
uniform int u_levels;
uniform float u_cleanBlack;
uniform float u_cleanWhite;
uniform float u_ratio;
float alphaLevels(float alpha) {
  if (u_levels == 1) {
    if (u_cleanWhite <= u_cleanBlack) alpha = alpha >= u_cleanBlack ? 1.0 : 0.0;
    else if (u_cleanBlack != 0.0 || u_cleanWhite != 1.0) {
      alpha = clamp((alpha - u_cleanBlack) / (u_cleanWhite - u_cleanBlack), 0.0, 1.0);
    }
  }
  if (u_ratio != 0.0) {
    float mid = 0.5 - clamp(u_ratio, -1.0, 1.0) * 0.5;
    if (mid <= 0.0) alpha = alpha > 0.0 ? 1.0 : 0.0;
    else if (mid >= 1.0) alpha = alpha >= 1.0 ? 1.0 : 0.0;
    else {
      float mapped = alpha <= mid ? alpha * 0.5 / mid : 0.5 + (alpha - mid) * 0.5 / (1.0 - mid);
      alpha = clamp(mapped, 0.0, 1.0);
    }
  }
  return alpha;
}`;

/**
 * The pointwise tail: `apply_clean_levels`, `in_out_ratio` and `layer_alpha`.
 *
 * They are one pass because each is a handful of arithmetic ops, and splitting them would cost
 * two more full-frame targets for nothing.
 */
export const MASK_LEVELS_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_alpha;
uniform float u_invert;
uniform float u_opacity;
${ALPHA_LEVELS_GLSL}
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float alpha = alphaLevels(texelFetch(u_alpha, p, 0).r);
  o_color = vec4((u_invert == 1.0 ? 1.0 - alpha : alpha) * u_opacity, 0.0, 0.0, 1.0);
}`;

/** A key's finesse group, read at the instant, as the compositor's passes need it. */
export interface KeyFinesse {
  readonly denoise: number;
  readonly cleanBlack: number;
  readonly cleanWhite: number;
  readonly morphOpenPx: number;
  readonly morphClosePx: number;
  readonly shrinkGrowPx: number;
  readonly blurPx: number;
  readonly inOutRatio: number;
}

/** Whether a key's finesse asks for a morphology radius no single pass can carry. */
export function keyMorphExceedsPass(mask: KeyMask): boolean {
  const { morphOpenPx, morphClosePx, shrinkGrowPx } = mask.finesse;
  return (
    morphOpenPx > MAX_KEY_MORPH_PX ||
    morphClosePx > MAX_KEY_MORPH_PX ||
    Math.abs(shrinkGrowPx) > MAX_KEY_MORPH_PX
  );
}
