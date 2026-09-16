/**
 * Effect layers (schema v13) on the finished frame, as `render/frame_effects` computes them
 * (PX2.2).
 *
 * The earlier preview chain (`effects/gl-effect-chain.ts`) approximated several passes (its
 * "gaussian" was 25 sparse taps, the numpy side three box passes), sampled a flipped texture
 * and ran after the 2D canvas had already been drawn, so effect layers were the least
 * faithful part of the monitor. These are line-by-line ports of the numpy passes: the same
 * pixel grid (`coord_grid`, `normalized_grid` at pixel centres, y down), the same
 * `sample_bilinear` edge clamp, the same summed-area box blur (as two clamped 1-D passes), the
 * same integer hash for noise, float32 intermediates, Python's `round` where the pass rounds,
 * the dispatcher's intensity mix and its `(x * 255 + 0.5)` quantisation.
 *
 * Scalar envelopes (flash, flicker, strobe, shake, zoom punch, whip pan, light-leak drift) are
 * evaluated on the CPU exactly as the Python pass evaluates them and passed as uniforms.
 */
import type { EffectRenderKind } from '@framepilot/timeline-schema';
import { clampParamsForKind } from '@framepilot/timeline-schema/effect-params';
import type { GlResources, Program, RenderTarget } from './gl-resources.js';

/** One live effect layer at the frame being drawn. */
export interface FrameEffectInstance {
  readonly kind: EffectRenderKind;
  readonly params: Readonly<Record<string, number>>;
  readonly intensity: number;
  /** Layer-relative seconds. */
  readonly localTime: number;
  /** Layer length in seconds. */
  readonly duration: number;
}

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_src;
uniform ivec2 u_size;
uniform float u_f[24];
out vec4 o_color;
const vec3 REC709 = vec3(0.2126, 0.7152, 0.0722);
const float PI = 3.141592653589793;
vec3 at(sampler2D t, int x, int y) {
  return texelFetch(t, ivec2(clamp(x, 0, u_size.x - 1), clamp(y, 0, u_size.y - 1)), 0).rgb;
}
vec3 sampleBilinear(sampler2D t, float sy, float sx) {
  float x = clamp(sx, 0.0, float(u_size.x) - 1.0);
  float y = clamp(sy, 0.0, float(u_size.y) - 1.0);
  int x0 = int(floor(x));
  int y0 = int(floor(y));
  int x1 = min(x0 + 1, u_size.x - 1);
  int y1 = min(y0 + 1, u_size.y - 1);
  float fx = x - float(x0);
  float fy = y - float(y0);
  vec3 p00 = texelFetch(t, ivec2(x0, y0), 0).rgb;
  vec3 p10 = texelFetch(t, ivec2(x1, y0), 0).rgb;
  vec3 p01 = texelFetch(t, ivec2(x0, y1), 0).rgb;
  vec3 p11 = texelFetch(t, ivec2(x1, y1), 0).rgb;
  vec3 top = p00 + (p10 - p00) * fx;
  vec3 bottom = p01 + (p11 - p01) * fx;
  return top + (bottom - top) * fy;
}
float luma(vec3 c) { return c.r * REC709.r + c.g * REC709.g + c.b * REC709.b; }
float sstep(float e0, float e1, float x) {
  float span = e1 - e0;
  if (abs(span) < 1e-6) return x >= e1 ? 1.0 : 0.0;
  float t = clamp((x - e0) / span, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
vec3 sstep3(float e0, float e1, vec3 x) { return vec3(sstep(e0, e1, x.r), sstep(e0, e1, x.g), sstep(e0, e1, x.b)); }
uint hashU32(uint v) {
  uint x = v;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float noise01(int x, int y, uint seed) {
  uint key = hashU32(uint(x) ^ hashU32(uint(y) ^ seed));
  return float(key >> 8u) / 16777216.0;
}
float valueNoise01(float x, float y, uint seed, float cell) {
  float scale = max(1e-3, cell);
  float fx = x / scale;
  float fy = y / scale;
  float x0 = floor(fx);
  float y0 = floor(fy);
  float tx = fx - x0;
  float ty = fy - y0;
  float sx = tx * tx * (3.0 - 2.0 * tx);
  float sy = ty * ty * (3.0 - 2.0 * ty);
  int xi = int(x0);
  int yi = int(y0);
  float n00 = noise01(xi, yi, seed);
  float n10 = noise01(xi + 1, yi, seed);
  float n01 = noise01(xi, yi + 1, seed);
  float n11 = noise01(xi + 1, yi + 1, seed);
  float top = n00 + (n10 - n00) * sx;
  float bottom = n01 + (n11 - n01) * sx;
  return top + (bottom - top) * sy;
}
`;

/** A seed as `(frame * 0x9E3779B1 + salt) & 0xFFFFFFFF`, passed as a uint uniform. */
function noiseSeed(frame: number, salt: number): number {
  return (Math.imul(frame >>> 0, 0x9e3779b1) + salt) >>> 0;
}

/** `hashU32` on the CPU (bit-identical to the GLSL and numpy mixers). */
export function hashU32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

export function noise01Cpu(x: number, y: number, frame: number, salt: number): number {
  const key = hashU32((x >>> 0) ^ hashU32((y >>> 0) ^ noiseSeed(frame, salt)));
  return Math.fround((key >>> 8) / 16777216);
}

/** `quantize_time`. */
const quantizeTime = (t: number): number => Math.floor(Math.max(0, t) / (1 / 60));

/** Python's `round` (half to even). */
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `hue_to_rgb`. */
function hueToRgb(hueDegrees: number): [number, number, number] {
  const h = (((hueDegrees % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const table: [number, number, number][] = [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x],
  ];
  return table[Math.trunc(h) % 6]!;
}

/** `smoothstep` on a scalar. */
function smoothstepCpu(e0: number, e1: number, x: number): number {
  const span = e1 - e0;
  if (Math.abs(span) < 1e-6) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / span));
  return t * t * (3 - 2 * t);
}

// --- shaders ------------------------------------------------------------------------------------

/** Box blur along one axis with edge replication: `separable_box` split in two. */
const BOX_AXIS = `${HEADER}
uniform int u_radius;
uniform int u_axis;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 total = vec3(0.0);
  for (int k = -64; k <= 64; k++) {
    if (k < -u_radius || k > u_radius) continue;
    total += u_axis == 0 ? at(u_src, p.x + k, p.y) : at(u_src, p.x, p.y + k);
  }
  o_color = vec4(total / float(2 * u_radius + 1), 1.0);
}`;

/** Multiply by a smoothstep mask of luma (bloom and halation's highlight key). */
const LUMA_KEY = `${HEADER}
void main() {
  vec3 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb;
  o_color = vec4(c * sstep(u_f[0], u_f[1], luma(c)), 1.0);
}`;

/** `_sobel(luminance(frame))`, then `smoothstep(lo, hi, edges)` in `.r`. */
const SOBEL = `${HEADER}
float l(int x, int y) { return luma(at(u_src, x, y)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float gx = -l(p.x - 1, p.y - 1) - 2.0 * l(p.x - 1, p.y) - l(p.x - 1, p.y + 1)
    + l(p.x + 1, p.y - 1) + 2.0 * l(p.x + 1, p.y) + l(p.x + 1, p.y + 1);
  float gy = -l(p.x - 1, p.y - 1) - 2.0 * l(p.x, p.y - 1) - l(p.x + 1, p.y - 1)
    + l(p.x - 1, p.y + 1) + 2.0 * l(p.x, p.y + 1) + l(p.x + 1, p.y + 1);
  float e = clamp(sqrt(gx * gx + gy * gy) / 4.0, 0.0, 1.0);
  e = sstep(u_f[0], u_f[1], e);
  o_color = vec4(e, e, e, 1.0);
}`;

/** `clip(x * factor, 0, 1)` (the thicken re-threshold). */
const SCALE_CLIP = `${HEADER}
void main() {
  vec3 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb;
  o_color = vec4(clamp(c * u_f[0], 0.0, 1.0), 1.0);
}`;

/** `np.maximum(smeared, roll(smeared, step, axis) * mask)`; `u_aux0` holds the mask in `.r`. */
const PIXEL_SORT_STEP = `${HEADER}
uniform sampler2D u_aux0;
uniform int u_step;
uniform int u_axis;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = u_axis == 0
    ? ivec2((p.x - u_step % u_size.x + u_size.x) % u_size.x, p.y)
    : ivec2(p.x, (p.y - u_step % u_size.y + u_size.y) % u_size.y);
  vec3 rolled = texelFetch(u_src, q, 0).rgb * texelFetch(u_aux0, p, 0).r;
  o_color = vec4(max(texelFetch(u_src, p, 0).rgb, rolled), 1.0);
}`;

/** `(luma > threshold)` in `.r`. */
const LUMA_THRESHOLD = `${HEADER}
void main() {
  float m = luma(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb) > u_f[0] ? 1.0 : 0.0;
  o_color = vec4(m, m, m, 1.0);
}`;

/** The final kind pass: `u_src` the effect input, `u_aux*` its precomputed stages. */
function kindPass(body: string): string {
  return `${HEADER}
uniform sampler2D u_aux0;
uniform sampler2D u_aux1;
uniform uint u_seed0;
uniform uint u_seed1;
uniform uint u_seed2;
uniform int u_i[8];
${body}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 f = texelFetch(u_src, p, 0).rgb;
  o_color = vec4(effect(p, f), 1.0);
}`;
}

const V = `(float(p.y) + 0.5) / float(u_size.y)`;
const U = `(float(p.x) + 0.5) / float(u_size.x)`;

const KIND_BODIES: Readonly<Record<string, string>> = {
  'blur-gaussian': `vec3 effect(ivec2 p, vec3 f) { return texelFetch(u_aux0, p, 0).rgb; }`,
  'blur-directional': `vec3 effect(ivec2 p, vec3 f) {
    vec3 total = vec3(0.0);
    for (int i = 0; i < 9; i++) {
      float o = (float(i) / 8.0 - 0.5) * 2.0 * u_f[0];
      total += sampleBilinear(u_src, float(p.y) + u_f[2] * o, float(p.x) + u_f[1] * o);
    }
    return total / 9.0;
  }`,
  'blur-radial': `vec3 effect(ivec2 p, vec3 f) {
    vec3 total = vec3(0.0);
    for (int i = 0; i < 9; i++) {
      float scale = 1.0 - (float(i) / 8.0) * u_f[0] * 0.25;
      total += sampleBilinear(u_src, u_f[2] + (float(p.y) - u_f[2]) * scale, u_f[1] + (float(p.x) - u_f[1]) * scale);
    }
    return total / 9.0;
  }`,
  'tilt-shift': `vec3 effect(ivec2 p, vec3 f) {
    float v = ${V};
    float distance = abs(v - u_f[0]);
    float inner = max(0.01, u_f[1] * 0.5);
    float w = sstep(inner, inner + 0.12 + u_f[1] * 0.3, distance);
    return f + (texelFetch(u_aux0, p, 0).rgb - f) * w;
  }`,
  'soft-focus': `vec3 effect(ivec2 p, vec3 f) {
    vec3 b = texelFetch(u_aux0, p, 0).rgb;
    vec3 screened = 1.0 - (1.0 - f) * (1.0 - b);
    vec3 o = f + (screened - f) * u_f[0];
    return o + (1.0 - o) * u_f[1];
  }`,
  bloom: `vec3 effect(ivec2 p, vec3 f) {
    return max(f + texelFetch(u_aux0, p, 0).rgb * u_f[0], vec3(0.0));
  }`,
  'glow-diffuse': `vec3 effect(ivec2 p, vec3 f) {
    vec3 g = texelFetch(u_aux0, p, 0).rgb;
    vec3 screened = 1.0 - (1.0 - f) * (1.0 - g);
    return f + (screened - f) * u_f[0];
  }`,
  'edge-outline': `vec3 effect(ivec2 p, vec3 f) {
    float e = texelFetch(u_aux0, p, 0).r;
    return f + (1.0 - f) * e * u_f[0];
  }`,
  'neon-edge': `vec3 effect(ivec2 p, vec3 f) {
    float e = texelFetch(u_aux0, p, 0).r;
    float glow = texelFetch(u_aux1, p, 0).r;
    vec3 hue = vec3(u_f[1], u_f[2], u_f[3]);
    vec3 base = f * (1.0 - u_f[0] * 0.55);
    vec3 lit = (e + glow * 0.8) * hue * u_f[0] * 1.4;
    return 1.0 - (1.0 - base) * (1.0 - clamp(lit, 0.0, 1.0));
  }`,
  sketch: `vec3 effect(ivec2 p, vec3 f) {
    float paper = 1.0 - texelFetch(u_aux0, p, 0).r;
    return f + (vec3(paper) - f) * u_f[0];
  }`,
  'film-fade': `vec3 effect(ivec2 p, vec3 f) {
    float lift = u_f[0]; float rolloff = u_f[1]; float warmth = u_f[2]; float saturation = u_f[3];
    vec3 o = lift + f * (1.0 - lift);
    float knee = 1.0 - rolloff * 0.35;
    o = mix(o, knee + (o - knee) * (1.0 - rolloff), vec3(greaterThan(o, vec3(knee))));
    o = o * vec3(u_f[4], 1.0, u_f[5]);
    float l = luma(o);
    return l + (o - l) * saturation;
  }`,
  'film-curve': `vec3 effect(ivec2 p, vec3 f) {
    vec3 curved = f + (sstep3(0.0, 1.0, f) - f) * u_f[0];
    float l = luma(curved);
    float sw = clamp(1.0 - l * 2.0, 0.0, 1.0) * u_f[1];
    float hw = clamp(l * 2.0 - 1.0, 0.0, 1.0) * u_f[1];
    vec3 shadow = vec3(u_f[2], u_f[3], u_f[4]);
    vec3 highlight = vec3(u_f[5], u_f[6], u_f[7]);
    vec3 toned = curved * (1.0 - sw) + curved * shadow * sw * 1.6;
    return toned * (1.0 - hw) + (toned + (highlight - toned) * 0.5) * hw;
  }`,
  vignette: `vec3 effect(ivec2 p, vec3 f) {
    float v = ${V}; float u = ${U};
    float aspect = float(u_size.x) / float(max(1, u_size.y));
    float dx = (u - 0.5) * 2.0 * max(1.0, aspect);
    float dy = (v - 0.5) * 2.0 * max(1.0, 1.0 / aspect);
    float dist = sqrt(dx * dx + dy * dy);
    float falloff = sstep(u_f[1], u_f[2], dist);
    return f * (1.0 - falloff * u_f[0]);
  }`,
  'light-leak': `vec3 effect(ivec2 p, vec3 f) {
    float v = ${V}; float u = ${U};
    float axis = (u - 0.5) * u_f[0] + (v - 0.5) * u_f[1];
    float band = exp(-((axis - u_f[2]) * 6.0) * ((axis - u_f[2]) * 6.0));
    vec3 add = band * vec3(u_f[3], u_f[4], u_f[5]) * u_f[6];
    return 1.0 - (1.0 - f) * (1.0 - clamp(add, 0.0, 1.0));
  }`,
  'lens-flare': `vec3 effect(ivec2 p, vec3 f) {
    float v = ${V}; float u = ${U};
    float dx = u - u_f[0]; float dy = v - u_f[1];
    float s = dy * 60.0; float w = dx / (0.15 + u_f[3] * 0.5);
    float streak = exp(-(s * s)) * exp(-(w * w));
    float core = exp(-(dx * dx + dy * dy) * 600.0);
    float gx = u - (1.0 - u_f[0]); float gy = v - (1.0 - u_f[1]);
    float ghost = exp(-(gx * gx + gy * gy) * 300.0) * 0.4;
    vec3 add = ((streak + core) * vec3(0.55, 0.72, 1.0) + ghost) * u_f[2];
    return 1.0 - (1.0 - f) * (1.0 - clamp(add, 0.0, 1.0));
  }`,
  halation: `vec3 effect(ivec2 p, vec3 f) {
    vec3 add = texelFetch(u_aux0, p, 0).rgb * vec3(u_f[1], u_f[2], u_f[3]) * u_f[0];
    return 1.0 - (1.0 - f) * (1.0 - clamp(add, 0.0, 1.0));
  }`,
  'chroma-shift': `vec3 effect(ivec2 p, vec3 f) {
    float v = ${V}; float u = ${U};
    float dx = (u - 0.5) * 2.0; float dy = (v - 0.5) * 2.0;
    float radial = sqrt(dx * dx + dy * dy);
    float red = sampleBilinear(u_src, float(p.y) + u_f[1] * radial, float(p.x) + u_f[0] * radial).r;
    float blue = sampleBilinear(u_src, float(p.y) - u_f[1] * radial, float(p.x) - u_f[0] * radial).b;
    return vec3(red, f.g, blue);
  }`,
  'rgb-split': `vec3 effect(ivec2 p, vec3 f) {
    float red = at(u_src, p.x - u_i[0], p.y - u_i[1]).r;
    float blue = at(u_src, p.x + u_i[0], p.y + u_i[1]).b;
    return vec3(red, f.g, blue);
  }`,
  posterize: `vec3 effect(ivec2 p, vec3 f) {
    float l = luma(f);
    vec3 boosted = l + (f - l) * u_f[1];
    return roundEven(clamp(boosted, 0.0, 1.0) * u_f[0]) / u_f[0];
  }`,
  dither: `const mat4 BAYER = mat4(0.0, 12.0, 3.0, 15.0, 8.0, 4.0, 11.0, 7.0, 2.0, 14.0, 1.0, 13.0, 10.0, 6.0, 9.0, 5.0);
  vec3 effect(ivec2 p, vec3 f) {
    float threshold = BAYER[p.x % 4][p.y % 4] / 16.0 - 0.5;
    vec3 nudged = f + threshold * u_f[1] / u_f[0];
    return clamp(roundEven(clamp(nudged, 0.0, 1.0) * u_f[0]) / u_f[0], 0.0, 1.0);
  }`,
  flash: `vec3 effect(ivec2 p, vec3 f) { return f + (1.0 - f) * u_f[0]; }`,
  flicker: `vec3 effect(ivec2 p, vec3 f) { return f * (1.0 - u_f[0] * (1.0 - u_f[1])); }`,
  'strobe-color': `vec3 effect(ivec2 p, vec3 f) {
    float l = luma(f);
    return f + (l * vec3(u_f[0], u_f[1], u_f[2]) - f) * u_f[3];
  }`,
  fisheye: `vec3 effect(ivec2 p, vec3 f) {
    float v = ${V}; float u = ${U};
    float aspect = float(u_size.x) / float(max(1, u_size.y));
    float cx = (u - 0.5) * 2.0; float cy = (v - 0.5) * 2.0;
    if (aspect >= 1.0) cx = cx * aspect; else cy = cy / aspect;
    float radius = sqrt(cx * cx + cy * cy);
    float theta = atan(radius * (1.0 + u_f[0] * 2.0));
    float safeRadius = max(radius, 1e-6);
    float scale = radius > 1e-6 ? theta / (safeRadius * (PI / 2.0)) : 1.0;
    scale = scale / u_f[1];
    float x = cx * scale; float y = cy * scale;
    x = aspect >= 1.0 ? x / aspect : x; y = aspect >= 1.0 ? y : y * aspect;
    return sampleBilinear(u_src, (y * 0.5 + 0.5) * float(u_size.y) - 0.5, (x * 0.5 + 0.5) * float(u_size.x) - 0.5);
  }`,
  'barrel-warp': `vec3 effect(ivec2 p, vec3 f) {
    float v = ${V}; float u = ${U};
    float aspect = float(u_size.x) / float(max(1, u_size.y));
    float cx = (u - 0.5) * 2.0; float cy = (v - 0.5) * 2.0;
    if (aspect >= 1.0) cx = cx * aspect; else cy = cy / aspect;
    float factor = 1.0 + u_f[0] * 0.4 * (cx * cx + cy * cy);
    float x = cx * factor; float y = cy * factor;
    x = aspect >= 1.0 ? x / aspect : x; y = aspect >= 1.0 ? y : y * aspect;
    return sampleBilinear(u_src, (y * 0.5 + 0.5) * float(u_size.y) - 0.5, (x * 0.5 + 0.5) * float(u_size.x) - 0.5);
  }`,
  ripple: `vec3 effect(ivec2 p, vec3 f) {
    float ys = float(p.y); float xs = float(p.x);
    float dx = sin(ys / u_f[3] * u_f[1] * 2.0 * PI + u_f[2]) * u_f[0];
    float dy = cos(xs / u_f[4] * u_f[1] * 2.0 * PI + u_f[2]) * u_f[0] * 0.6;
    return sampleBilinear(u_src, ys + dy, xs + dx);
  }`,
  mirror: `vec3 effect(ivec2 p, vec3 f) {
    int axis = u_i[0]; int seam = u_i[1]; int span = u_i[2];
    if (axis == 0 && p.x >= seam && p.x < seam + span) return texelFetch(u_src, ivec2(2 * seam - 1 - p.x, p.y), 0).rgb;
    if (axis == 1 && p.x >= seam - span && p.x < seam) return texelFetch(u_src, ivec2(2 * seam - 1 - p.x, p.y), 0).rgb;
    if (axis == 2 && p.y >= seam && p.y < seam + span) return texelFetch(u_src, ivec2(p.x, 2 * seam - 1 - p.y), 0).rgb;
    if (axis == 3 && p.y >= seam - span && p.y < seam) return texelFetch(u_src, ivec2(p.x, 2 * seam - 1 - p.y), 0).rgb;
    return f;
  }`,
  kaleidoscope: `vec3 effect(ivec2 p, vec3 f) {
    float v = ${V}; float u = ${U};
    float aspect = float(u_size.x) / float(max(1, u_size.y));
    float cx = (u - 0.5) * 2.0; float cy = (v - 0.5) * 2.0;
    if (aspect >= 1.0) cx = cx * aspect; else cy = cy / aspect;
    float radius = sqrt(cx * cx + cy * cy);
    float angle = atan(cy, cx) + u_f[0];
    float wedge = u_f[1];
    float folded = angle - wedge * floor(angle / wedge);
    folded = min(folded, wedge - folded);
    float r = radius / u_f[2];
    float x = cos(folded) * r; float y = sin(folded) * r;
    x = aspect >= 1.0 ? x / aspect : x; y = aspect >= 1.0 ? y : y * aspect;
    return sampleBilinear(u_src, (y * 0.5 + 0.5) * float(u_size.y) - 0.5, (x * 0.5 + 0.5) * float(u_size.x) - 0.5);
  }`,
  shake: `vec3 effect(ivec2 p, vec3 f) {
    float cx = float(u_size.x) * 0.5; float cy = float(u_size.y) * 0.5;
    float dx = float(p.x) - cx; float dy = float(p.y) - cy;
    float rx = (dx * u_f[0] - dy * u_f[1]) * u_f[2] + cx + u_f[3];
    float ry = (dx * u_f[1] + dy * u_f[0]) * u_f[2] + cy + u_f[4];
    return sampleBilinear(u_src, ry, rx);
  }`,
  'zoom-punch': `vec3 effect(ivec2 p, vec3 f) {
    float cx = float(u_size.x) * 0.5; float cy = float(u_size.y) * 0.5;
    return sampleBilinear(u_src, cy + (float(p.y) - cy) * u_f[0], cx + (float(p.x) - cx) * u_f[0]);
  }`,
  'whip-pan': `vec3 effect(ivec2 p, vec3 f) {
    vec3 total = vec3(0.0);
    for (int i = 0; i < 7; i++) {
      float k = (float(i) / 6.0) * u_f[2];
      total += sampleBilinear(u_src, float(p.y) + u_f[1] * k, float(p.x) + u_f[0] * k);
    }
    return total / 7.0;
  }`,
  mosaic: `vec3 effect(ivec2 p, vec3 f) {
    int size = u_i[0];
    int cy = clamp((p.y / size) * size + size / 2, 0, u_size.y - 1);
    int cx = clamp((p.x / size) * size + size / 2, 0, u_size.x - 1);
    return texelFetch(u_aux0, ivec2(cx, cy), 0).rgb;
  }`,
  halftone: `vec3 effect(ivec2 p, vec3 f) {
    float xs = float(p.x); float ys = float(p.y); float dot = u_f[0];
    float rx = xs * u_f[1] - ys * u_f[2];
    float ry = xs * u_f[2] + ys * u_f[1];
    float fx = (rx - dot * floor(rx / dot)) / dot - 0.5;
    float fy = (ry - dot * floor(ry / dot)) / dot - 0.5;
    float dist = sqrt(fx * fx + fy * fy) * 2.0;
    float l = luma(texelFetch(u_aux0, p, 0).rgb);
    float radius = sqrt(clamp(1.0 - l, 0.0, 1.0));
    float ink = sstep(0.0, 0.25, radius - dist);
    return f + (vec3(1.0 - ink) - f) * u_f[3];
  }`,
  'pixel-sort': `vec3 effect(ivec2 p, vec3 f) {
    return f + (texelFetch(u_aux0, p, 0).rgb - f) * u_f[0];
  }`,
  grain: `vec3 effect(ivec2 p, vec3 f) {
    int gy = int(float(p.y) / u_f[1]);
    int gx = int(float(p.x) / u_f[1]);
    float n = noise01(gx, gy, u_seed0) - 0.5;
    float w = clamp(1.0 - abs(luma(f) - 0.5) * 1.6, 0.15, 1.0);
    return f + n * w * u_f[0] * 0.5;
  }`,
  'dust-scratches': `vec3 effect(ivec2 p, vec3 f) {
    vec3 o = f;
    if (u_f[0] > 0.0) {
      float spec = noise01(p.x / 3, p.y / 3, u_seed0);
      float hit = sstep(u_f[2], 1.0, spec);
      float polarity = noise01(p.x / 3, p.y / 3, u_seed1);
      o = polarity > 0.5 ? o + hit : o * (1.0 - hit);
    }
    if (u_f[1] > 0.0) {
      float cols = noise01(p.x / 2, 0, u_seed2);
      o = o + sstep(u_f[3], 1.0, cols) * 0.35;
    }
    return o;
  }`,
  scanlines: `vec3 effect(ivec2 p, vec3 f) {
    float phase = float(p.y) / float(u_size.y) * u_f[0] + u_f[2];
    float line = 0.5 + 0.5 * cos(phase * float(2.0 * PI));
    return f * (1.0 - u_f[1] * line);
  }`,
  'analog-vhs': `vec3 effect(ivec2 p, vec3 f) {
    return texelFetch(u_aux0, p, 0).rgb;
  }`,
  'tape-dropout': `vec3 effect(ivec2 p, vec3 f) {
    float line = noise01(0, p.y, u_seed0);
    float hit = sstep(u_f[0], 1.0, line);
    float start = noise01(0, p.y, u_seed1);
    float u = float(p.x) / float(u_size.x);
    float span = u_f[1];
    float inside = sstep(0.0, 0.02, u - start) * (1.0 - sstep(span - 0.05, span, u - start));
    float streak = hit * inside;
    float l = luma(f);
    return f + (0.85 + l * 0.15 - f) * streak;
  }`,
  'glitch-block': `vec3 effect(ivec2 p, vec3 f) {
    return texelFetch(u_aux0, p, 0).rgb;
  }`,
  datamosh: `vec3 effect(ivec2 p, vec3 f) {
    int bx = p.x / u_i[0]; int by = p.y / u_i[0];
    float vx = (noise01(bx, by, u_seed0) - 0.5) * 2.0;
    float vy = (noise01(bx, by, u_seed1) - 0.5) * 2.0;
    vec3 total = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      float k = (float(i) / 4.0) * u_f[1];
      total += sampleBilinear(u_src, float(p.y) + vy * k, float(p.x) + vx * k);
    }
    return f + (total / 5.0 - f) * u_f[0];
  }`,
};

/** analog-vhs stage 1: jitter + tracking band warp into `.rgb`. */
const VHS_WARP = `${HEADER}
uniform uint u_seed0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float fy = float(p.y); float fx = float(p.x);
  float lineNoise = valueNoise01(0.0, fy, u_seed0, 3.0) - 0.5;
  float offset = lineNoise * u_f[0] * 0.05 * float(u_size.x);
  float d = (fy / float(u_size.y) - u_f[1]) * 22.0;
  float band = exp(-(d * d));
  offset = offset + band * u_f[2] * 0.12 * float(u_size.x);
  o_color = vec4(sampleBilinear(u_src, fy, fx + offset), 1.0);
}`;

/** analog-vhs stage 2 (input = warped): chroma bleed + tape noise. */
const VHS_BLEED = `${HEADER}
uniform uint u_seed0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 warped = texelFetch(u_src, p, 0).rgb;
  vec3 bled = sampleBilinear(u_src, float(p.y), float(p.x) - u_f[1]);
  float chroma = u_f[0];
  vec3 o = vec3(warped.r + (bled.r - warped.r) * chroma, warped.g, warped.b + (bled.b - warped.b) * chroma);
  float n = noise01(p.x, p.y, u_seed0) - 0.5;
  float dark = clamp(1.0 - luma(o), 0.2, 1.0);
  o_color = vec4(o + n * dark * u_f[2] * 0.35, 1.0);
}`;

/** glitch-block stage 1 (torn) into `.rgb`, `.a` unused; stage 2 reads `u_aux0` = torn. */
const GLITCH_TEAR = `${HEADER}
uniform uint u_seed0;
uniform uint u_seed1;
uniform int u_blockH;
float active(int row) { return noise01(0, row, u_seed0) > u_f[0] ? 1.0 : 0.0; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int row = p.y / u_blockH;
  float a = active(row);
  float amount = (noise01(0, row, u_seed1) - 0.5) * 2.0;
  float offset = a * amount * u_f[1] * 0.25 * float(u_size.x);
  o_color = vec4(sampleBilinear(u_src, float(p.y), float(p.x) + offset), 1.0);
}`;

const GLITCH_REGISTER = `${HEADER}
uniform uint u_seed0;
uniform int u_blockH;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int row = p.y / u_blockH;
  float a = noise01(0, row, u_seed0) > u_f[0] ? 1.0 : 0.0;
  float shift = a * u_f[1] * 0.01 * float(u_size.x);
  vec3 torn = texelFetch(u_src, p, 0).rgb;
  vec3 reg = sampleBilinear(u_src, float(p.y), float(p.x) + shift);
  o_color = vec4(reg.r, torn.g, torn.b, 1.0);
}`;

/** Dispatcher tail: intensity mix, clip, `(x * 255 + 0.5)` truncation into 8 bits. */
const FINISH = `${HEADER}
uniform sampler2D u_result;
uniform float u_strength;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 source = texelFetch(u_src, p, 0).rgb;
  vec3 result = texelFetch(u_result, p, 0).rgb;
  if (u_strength < 1.0) result = source + (result - source) * u_strength;
  result = clamp(result, 0.0, 1.0);
  o_color = vec4(floor(result * 255.0 + 0.5) / 255.0, 1.0);
}`;

/** Runs effect layers over a composited frame inside the layer compositor's context. */
export class FrameEffectRenderer {
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly resources: GlResources,
  ) {}

  /** Whether float render targets exist (needed for exact intermediates). */
  static supported(gl: WebGL2RenderingContext): boolean {
    return gl.getExtension('EXT_color_buffer_float') !== null;
  }

  private run(
    name: string,
    fragment: string,
    source: RenderTarget,
    setup: (program: Program) => void,
    aux: readonly RenderTarget[] = [],
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba32f');
    const program = r.program(name, fragment);
    this.gl.useProgram(program.handle);
    r.bind(program, 'u_src', 0, source.texture);
    aux.forEach((target, index) => r.bind(program, `u_aux${index}`, index + 1, target.texture));
    program.ivec2('u_size', source.width, source.height);
    setup(program);
    r.draw(out, out.width, out.height);
    return out;
  }

  private floats(program: Program, values: readonly number[]): void {
    const array = new Float32Array(24);
    array.set(values.slice(0, 24));
    this.gl.uniform1fv(program.location('u_f'), array);
  }

  private box(source: RenderTarget, radius: number): RenderTarget {
    const r = pyRound(Math.max(0, radius));
    if (r <= 0) return source;
    const radiusPx = Math.min(64, r);
    const horizontal = this.run('fx-box', BOX_AXIS, source, (p) => {
      p.int('u_radius', radiusPx);
      p.int('u_axis', 0);
    });
    return this.run('fx-box', BOX_AXIS, horizontal, (p) => {
      p.int('u_radius', radiusPx);
      p.int('u_axis', 1);
    });
  }

  private gaussian(source: RenderTarget, radius: number): RenderTarget {
    if (radius <= 0) return source;
    const boxRadius = Math.max(1, radius / 3);
    return this.box(this.box(this.box(source, boxRadius), boxRadius), boxRadius);
  }

  private sobel(source: RenderTarget, lo: number, hi: number): RenderTarget {
    return this.run('fx-sobel', SOBEL, source, (p) => this.floats(p, [lo, hi]));
  }

  private thicken(edges: RenderTarget, thickness: number): RenderTarget {
    if (thickness <= 0) return edges;
    const radius = 1 + thickness * 3;
    const spread = this.box(edges, radius);
    return this.run('fx-scale-clip', SCALE_CLIP, spread, (p) => this.floats(p, [1 + radius]));
  }

  /**
   * Apply `effects` in order to `frame` (8-bit) and return the 8-bit result.
   */
  apply(frame: RenderTarget, effects: readonly FrameEffectInstance[]): RenderTarget {
    let current = frame;
    for (const effect of effects) {
      const strength = Math.min(1, Math.max(0, effect.intensity));
      if (strength <= 0) continue;
      const body = KIND_BODIES[effect.kind];
      if (body === undefined) continue;
      const params = clampParamsForKind(effect.kind, effect.params);
      const result = this.kind(effect, params, current, body);
      if (result === null) continue;
      const finished = this.resources.target(current.width, current.height, 'rgba8');
      const program = this.resources.program('fx-finish', FINISH);
      this.gl.useProgram(program.handle);
      this.resources.bind(program, 'u_src', 0, current.texture);
      this.resources.bind(program, 'u_result', 1, result.texture);
      program.ivec2('u_size', current.width, current.height);
      this.gl.uniform1f(program.location('u_strength'), strength);
      this.resources.draw(finished, finished.width, finished.height);
      current = finished;
    }
    return current;
  }

  /** The pass at full strength, or `null` when the pass returns its input unchanged. */
  private kind(
    effect: FrameEffectInstance,
    params: Readonly<Record<string, number>>,
    src: RenderTarget,
    body: string,
  ): RenderTarget | null {
    const P = (name: string): number => params[name] ?? 0;
    const W = src.width;
    const H = src.height;
    const t = effect.localTime;
    const progress = effect.duration <= 0 ? 0 : Math.min(1, Math.max(0, t / effect.duration));
    const name = `fx-kind:${effect.kind}`;
    const fragment = kindPass(body);
    const plain = (
      values: readonly number[],
      aux: readonly RenderTarget[] = [],
      extra?: (p: Program) => void,
    ): RenderTarget =>
      this.run(
        name,
        fragment,
        src,
        (p) => {
          this.floats(p, values);
          extra?.(p);
        },
        aux,
      );
    const ints = (p: Program, values: readonly number[]): void => {
      const array = new Int32Array(8);
      array.set(values.slice(0, 8));
      this.gl.uniform1iv(p.location('u_i'), array);
    };
    const seeds = (p: Program, values: readonly number[]): void => {
      values.forEach((value, index) => this.gl.uniform1ui(p.location(`u_seed${index}`), value));
    };

    switch (effect.kind) {
      case 'blur-gaussian':
        return plain([], [this.gaussian(src, P('radius'))]);
      case 'blur-directional': {
        const radius = P('radius');
        if (radius <= 0.5) return null;
        const angle = (P('angle') * Math.PI) / 180;
        return plain([radius, Math.cos(angle), Math.sin(angle)]);
      }
      case 'blur-radial': {
        if (P('strength') <= 0) return null;
        return plain([P('strength'), P('centerX') * W, P('centerY') * H]);
      }
      case 'tilt-shift':
        return plain([P('focusY'), P('bandHeight')], [this.gaussian(src, P('radius'))]);
      case 'soft-focus':
        return plain([P('mix'), P('lift')], [this.gaussian(src, P('radius'))]);
      case 'bloom': {
        const threshold = P('threshold');
        const keyed = this.run('fx-luma-key', LUMA_KEY, src, (p) =>
          this.floats(p, [threshold, Math.min(1, threshold + 0.2)]),
        );
        return plain([P('strength')], [this.gaussian(keyed, P('radius'))]);
      }
      case 'glow-diffuse':
        return plain([P('strength')], [this.gaussian(src, P('radius'))]);
      case 'edge-outline': {
        const threshold = P('threshold');
        const edges = this.thicken(
          this.sobel(src, threshold, Math.min(1, threshold + 0.15)),
          P('thickness'),
        );
        return plain([P('mix')], [edges]);
      }
      case 'neon-edge': {
        const threshold = P('threshold');
        const edges = this.thicken(
          this.sobel(src, threshold, Math.min(1, threshold + 0.12)),
          P('thickness'),
        );
        const hue = hueToRgb(P('hue'));
        return plain([P('strength'), ...hue], [edges, this.gaussian(edges, 8)]);
      }
      case 'sketch': {
        const threshold = P('threshold');
        const ink = this.sobel(src, threshold * 0.5, Math.min(1, threshold * 0.5 + 0.25));
        return plain([P('strength')], [ink]);
      }
      case 'film-fade': {
        const warmth = P('warmth');
        return plain([
          P('lift'),
          P('rolloff'),
          warmth,
          P('saturation'),
          Math.fround(1 + warmth * 0.12),
          Math.fround(1 - warmth * 0.12),
        ]);
      }
      case 'film-curve':
        return plain([
          P('contrast'),
          P('strength'),
          ...hueToRgb(P('shadowTint')),
          ...hueToRgb(P('highlightTint')),
        ]);
      case 'vignette': {
        const radius = Math.fround(P('radius'));
        const inner = Math.fround(radius * 1.4);
        const outer = Math.fround(inner + 0.05 + Math.fround(P('softness')) * 1.2);
        return plain([P('amount'), inner, outer]);
      }
      case 'light-leak': {
        const angle = (P('angle') * Math.PI) / 180;
        const frameIdx = quantizeTime(t);
        const wobble = noise01Cpu(0, 0, Math.floor(frameIdx / 12), 0);
        const centre = Math.fround(P('position') - 0.5 + (wobble - 0.5) * 0.06);
        const warmth = P('warmth');
        const tint = [1, 0.72 + 0.2 * warmth, 0.42 + 0.1 * warmth];
        const max = Math.max(...tint, 1e-6);
        return plain([
          Math.cos(angle),
          Math.sin(angle),
          centre,
          ...tint.map((value) => value / max),
          P('strength'),
        ]);
      }
      case 'lens-flare':
        return plain([P('x'), P('y'), P('strength'), P('spread')]);
      case 'halation': {
        const threshold = P('threshold');
        const keyed = this.run('fx-luma-key', LUMA_KEY, src, (p) =>
          this.floats(p, [threshold, Math.min(1, threshold + 0.25)]),
        );
        return plain([P('strength'), ...hueToRgb(P('tint'))], [this.gaussian(keyed, 18)]);
      }
      case 'chroma-shift': {
        const angle = (P('angle') * Math.PI) / 180;
        const px = P('amount') * 0.02 * W;
        return plain([px * Math.cos(angle), px * Math.sin(angle)]);
      }
      case 'rgb-split': {
        const angle = (P('angle') * Math.PI) / 180;
        const px = P('amount') * 0.03 * W;
        const dx = pyRound(px * Math.cos(angle));
        const dy = pyRound(px * Math.sin(angle));
        return plain([], [], (p) => ints(p, [dx, dy]));
      }
      case 'posterize':
        return plain([Math.max(2, P('levels')) - 1, P('saturation')]);
      case 'dither':
        return plain([Math.max(2, P('levels')) - 1, P('strength')]);
      case 'flash': {
        const frequency = P('frequency');
        const duty = P('duty');
        if (frequency <= 0) return null;
        const phase = (((t * frequency) % 1) + 1) % 1;
        if (phase >= duty || duty <= 0) return null;
        return plain([Math.fround(1 - phase / duty) * P('strength')]);
      }
      case 'flicker': {
        const frequency = P('frequency');
        if (frequency <= 0) return null;
        const regular = Math.fround(0.5 + 0.5 * Math.sin(t * frequency * 2 * Math.PI));
        const step = quantizeTime(t * Math.max(0.1, frequency) * 0.25);
        const jitter = noise01Cpu(0, 0, step, 7);
        const irregular = Math.fround(P('irregular'));
        return plain([P('depth'), Math.fround(regular + (jitter - regular) * irregular)]);
      }
      case 'strobe-color': {
        const frequency = P('frequency');
        if (frequency <= 0) return null;
        const phase = (((t * frequency) % 2) + 2) % 2;
        let blend = smoothstepCpu(0.85, 1.15, Math.fround(phase));
        if (phase > 1.5) blend = 1 - smoothstepCpu(1.85, 2, Math.fround(phase));
        const a = hueToRgb(P('hueA'));
        const b = hueToRgb(P('hueB'));
        return plain([...a.map((value, i) => value + (b[i]! - value) * blend), P('strength')]);
      }
      case 'fisheye':
        return plain([P('amount'), Math.max(0.01, P('zoom'))]);
      case 'barrel-warp':
        return plain([P('amount')]);
      case 'ripple': {
        const phase = t * P('speed') * 2 * Math.PI;
        return plain([
          P('amplitude') * 0.03 * W,
          P('frequency'),
          phase,
          Math.max(1, H),
          Math.max(1, W),
        ]);
      }
      case 'mirror': {
        const axis = pyRound(P('axis'));
        const offset = Math.min(1, Math.max(0, P('offset')));
        const extent = axis === 0 || axis === 1 ? W : H;
        const seam = Math.max(1, Math.min(extent - 1, pyRound(offset * extent)));
        const span = Math.min(seam, extent - seam);
        return plain([], [], (p) => ints(p, [axis, seam, span]));
      }
      case 'kaleidoscope': {
        const segments = Math.max(2, pyRound(P('segments')));
        return plain([
          (P('rotation') * Math.PI) / 180,
          (2 * Math.PI) / segments,
          Math.max(0.01, P('zoom')),
        ]);
      }
      case 'shake': {
        const amplitude = P('amplitude');
        const tt = t * P('frequency');
        const ox =
          (Math.sin(tt * 2 * Math.PI) + 0.6 * Math.sin(tt * 5.3 * Math.PI)) * amplitude * 0.02 * W;
        const oy =
          (Math.cos(tt * 2.3 * Math.PI) + 0.6 * Math.cos(tt * 4.7 * Math.PI)) *
          amplitude *
          0.02 *
          H;
        const angle = Math.sin(tt * 3.1 * Math.PI) * P('rotation') * 0.05;
        const overscan = Math.fround(
          1 / Math.fround(1 + Math.fround(amplitude) * Math.fround(0.06)),
        );
        return plain([Math.cos(angle), Math.sin(angle), overscan, ox, oy]);
      }
      case 'zoom-punch': {
        const attack = Math.max(1e-3, P('attack'));
        const hold = P('hold');
        let envelope: number;
        if (progress < attack) envelope = smoothstepCpu(0, 1, Math.fround(progress / attack));
        else if (progress < attack + hold) envelope = 1;
        else {
          const release = Math.max(1e-3, 1 - attack - hold);
          envelope = 1 - smoothstepCpu(0, 1, Math.fround((progress - attack - hold) / release));
        }
        return plain([Math.fround(1 / Math.fround(1 + Math.fround(P('amount')) * envelope))]);
      }
      case 'whip-pan': {
        const angle = (P('angle') * Math.PI) / 180;
        const envelope = Math.sin(Math.min(1, Math.max(0, progress)) * Math.PI);
        const shift = P('amount') * envelope * 0.5 * W;
        return plain([Math.cos(angle) * shift, Math.sin(angle) * shift, P('blur')]);
      }
      case 'mosaic': {
        const size = Math.max(2, pyRound(P('size')));
        return plain([], [this.box(src, size / 2)], (p) => ints(p, [size]));
      }
      case 'halftone': {
        const dot = Math.max(2, P('dotSize'));
        const angle = (P('angle') * Math.PI) / 180;
        return plain([dot, Math.cos(angle), Math.sin(angle), P('mix')], [this.box(src, dot / 3)]);
      }
      case 'pixel-sort': {
        const amount = P('amount');
        if (amount <= 0) return null;
        const vertical = pyRound(P('axis')) === 1;
        const mask = this.run('fx-luma-threshold', LUMA_THRESHOLD, src, (p) =>
          this.floats(p, [P('threshold')]),
        );
        const span = Math.max(1, pyRound(amount * 0.08 * (vertical ? H : W)));
        let smeared = src;
        for (let step = 1; step < span; step *= 2) {
          smeared = this.run(
            'fx-pixel-sort-step',
            PIXEL_SORT_STEP,
            smeared,
            (p) => {
              p.int('u_step', step);
              p.int('u_axis', vertical ? 1 : 0);
            },
            [mask],
          );
        }
        return plain([amount], [smeared]);
      }
      case 'grain': {
        const step = quantizeTime(t * Math.max(0, P('speed') * 24));
        return plain([P('amount'), Math.max(0.5, P('size'))], [], (p) =>
          seeds(p, [noiseSeed(step, 0)]),
        );
      }
      case 'dust-scratches': {
        const step = quantizeTime(t * Math.max(0, P('speed') * 8));
        const density = P('density');
        const scratches = P('scratches');
        return plain(
          [density, scratches, Math.fround(1 - density * 0.02), Math.fround(1 - scratches * 0.01)],
          [],
          (p) =>
            seeds(p, [
              noiseSeed(step, 11),
              noiseSeed(step, 12),
              noiseSeed(Math.floor(step / 3), 13),
            ]),
        );
      }
      case 'scanlines': {
        const count = Math.max(1, P('count'));
        const drift = t * P('speed') * P('roll') * count * 0.25;
        return plain([count, P('strength'), drift]);
      }
      case 'analog-vhs': {
        const step = quantizeTime(t * Math.max(0, P('speed') * 12));
        const bandCentre = Math.fround(((((t * 0.35) % 1.3) + 1.3) % 1.3) - 0.15);
        const warped = this.run('fx-vhs-warp', VHS_WARP, src, (p) => {
          this.floats(p, [P('jitter'), bandCentre, P('tracking')]);
          seeds(p, [noiseSeed(step, 21)]);
        });
        const chroma = P('chroma');
        const bled = this.run('fx-vhs-bleed', VHS_BLEED, warped, (p) => {
          this.floats(p, [chroma, Math.fround(chroma) * 0.012 * W, P('noise')]);
          seeds(p, [noiseSeed(step, 22)]);
        });
        return plain([], [bled]);
      }
      case 'tape-dropout': {
        const step = quantizeTime(t * Math.max(0, P('speed') * 10));
        return plain(
          [
            Math.fround(1 - P('density') * 0.15),
            Math.fround(0.05 + Math.fround(P('length')) * 0.5),
          ],
          [],
          (p) => seeds(p, [noiseSeed(step, 31), noiseSeed(step, 32)]),
        );
      }
      case 'glitch-block': {
        const step = quantizeTime(t * Math.max(0, P('speed') * 14));
        const blockH = Math.max(2, pyRound((0.02 + P('size') * 0.14) * H));
        const cutoff = Math.fround(1 - P('density') * 0.45);
        const displace = P('displace');
        const torn = this.run('fx-glitch-tear', GLITCH_TEAR, src, (p) => {
          this.floats(p, [cutoff, displace]);
          seeds(p, [noiseSeed(step, 41), noiseSeed(step, 42)]);
          p.int('u_blockH', blockH);
        });
        const registered = this.run('fx-glitch-register', GLITCH_REGISTER, torn, (p) => {
          this.floats(p, [cutoff, displace]);
          seeds(p, [noiseSeed(step, 41)]);
          p.int('u_blockH', blockH);
        });
        return plain([], [registered]);
      }
      case 'datamosh': {
        const strength = P('strength');
        if (strength <= 0) return null;
        const step = quantizeTime(t * Math.max(0, P('speed') * 6));
        const block = Math.max(4, pyRound((0.02 + P('blockSize') * 0.08) * Math.max(W, H)));
        return plain([strength, Math.fround(strength) * block], [], (p) => {
          ints(p, [block]);
          seeds(p, [noiseSeed(step, 51), noiseSeed(step, 52)]);
        });
      }
      default:
        return null;
    }
  }
}
