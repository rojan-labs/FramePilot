/**
 * Shared GLSL preamble for the transition passes.
 *
 * The GPU twin of `engine/python/framepilot_engine/render/transition_passes/`.
 * Every helper here must behave identically to its numpy counterpart, because the
 * whole point of a transition catalog is that the preview and the export show the
 * same picture.
 *
 * ## What a transition pass returns
 *
 * `vec4 transition(vec2 uv, float p)` — the INCOMING picture with an alpha, in
 * straight (non-premultiplied) alpha. The compositor underneath is unchanged: it
 * draws this over whatever is below, which is the outgoing clip where the two
 * overlap and black where they are sequential. That one signature is what makes 29
 * kinds tractable — a wipe is alpha, a slide is UV plus alpha, a 3D turn is a
 * perspective UV remap plus alpha.
 *
 * `p` is ALREADY EASED by the CPU (`easedProgress`), so a pass never needs to know
 * which curve it is on. `p = 0` is the start of the ramp (incoming absent), `p = 1`
 * is the end (incoming whole and untouched).
 *
 * ## Two things that took deliberate care
 *
 * 1. **`uIntensity` is not mixed by the epilogue.** For an effect layer, strength
 *    means "blend the result back towards the source", and the epilogue can do that
 *    generically. For a transition it cannot: at `p = 0` there is no source to
 *    blend back to, so a generic mix would make every transition start as a hard
 *    cut. Intensity is therefore each pass's own business — how far it slides, how
 *    much it zooms, how deep the dip goes — via {@link rem}.
 *
 * 2. **UV is y-UP, directions arrive y-DOWN.** The source texture is uploaded with
 *    `UNPACK_FLIP_Y_WEBGL` (see `gl-effect-chain.ts` for why the flip belongs at
 *    upload rather than in the vertex shader), so `vUv.y` grows upward through the
 *    picture. Every other direction consumer in the app is y-down, so `uDirection`
 *    is uploaded flipped once and `dirUv()` is the only thing that reads it.
 */

/** Vertex shader — a full-screen quad. Identical to the effect chain's. */
export const TRANSITION_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** Max params a kind may declare — the `uParams` array size. */
export const MAX_PARAMS = 8;

/**
 * The widest feather a softness of 1 buys, as a frame fraction.
 *
 * Mirrors `_WIPE_SOFTNESS_MAX` in `render/transitions.py`: past roughly a quarter
 * of the frame a wipe stops reading as an edge sweeping across and starts reading
 * as a biased dissolve, so the knob is bounded rather than open-ended.
 */
export const SOFTNESS_MAX = 0.25;

export const TRANSITION_FRAGMENT_PREAMBLE = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

/** The incoming picture. */
uniform sampler2D uTex;
/** Frame size in pixels. */
uniform vec2 uResolution;
/** Eased progress through the ramp, 0 → 1. */
uniform float uProgress;
/** How far the transition travels from rest, 0 → 1. */
uniform float uIntensity;
/** Mask feather, 0 → 1 (scaled by SOFTNESS_MAX before use). */
uniform float uSoftness;
/** Travel direction in UV space (already y-flipped). Zero when the kind has none. */
uniform vec2 uDirection;
/** +1 for 'in', -1 for 'out', 0 when the kind has no in/out sense. */
uniform float uDirSign;
/** CPU-quantized noise clock — see gl-effect-chain's TIME_QUANTUM. */
uniform int uNoiseFrame;
/** Clamped params in the kind's declared order. */
uniform float uParams[8];

const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
const vec3 REC709 = vec3(0.2126, 0.7152, 0.0722);
const float SOFTNESS_MAX = ${SOFTNESS_MAX};

float luma(vec3 c) { return dot(c, REC709); }

/** How much of the effect is still to be undone: 1 at the start, 0 at the end. */
float rem() { return (1.0 - uProgress) * uIntensity; }

/** Travel direction in UV space. */
vec2 dirUv() { return uDirection; }

/** The feather width as a frame fraction, never zero (the alpha formula divides). */
float softness() { return max(1e-3, uSoftness * SOFTNESS_MAX); }

/** Frame aspect (w/h), for keeping circles round on a 9:16 frame. */
float aspect() { return uResolution.x / max(1.0, uResolution.y); }

/** Scale UV deltas into a square space so distances are isotropic. */
vec2 squareUv(vec2 d) { return vec2(d.x * aspect(), d.y); }

/** Undo {@link squareUv}. */
vec2 unsquareUv(vec2 d) { return vec2(d.x / aspect(), d.y); }

vec2 rotate2(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// --- deterministic noise (mirrors deterministic.py) ------------------------

uint hashU32(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

/**
 * White noise in [0,1) that does NOT move with the clock.
 *
 * A pixel dissolve's arrangement must hold still while it resolves; deriving it
 * from the frame clock would make the blocks re-roll every frame and read as
 * static rather than as a dissolve. The animated variant below is for kinds whose
 * texture genuinely is meant to crawl.
 */
float noiseStable(ivec2 cell, int salt) {
  uint seed = uint(salt) * 0x9E3779B1u;
  uint key = hashU32(uint(cell.x) ^ hashU32(uint(cell.y) ^ seed));
  return float(key >> 8u) / 16777216.0;
}

/** White noise in [0,1) that advances with the quantized clock. */
float noise01(ivec2 cell, int salt) {
  uint seed = uint(uNoiseFrame * 0x9E3779B1 + salt);
  uint key = hashU32(uint(cell.x) ^ hashU32(uint(cell.y) ^ seed));
  return float(key >> 8u) / 16777216.0;
}

/** Smooth value noise on a stable grid. Mirrors value_noise01() with a fixed clock. */
float valueNoise01(vec2 p, float cell, int salt) {
  float scale = max(1e-3, cell);
  vec2 f = p / scale;
  vec2 i0 = floor(f);
  vec2 t = f - i0;
  vec2 s = t * t * (3.0 - 2.0 * t);
  ivec2 c = ivec2(i0);
  float n00 = noiseStable(c, salt);
  float n10 = noiseStable(c + ivec2(1, 0), salt);
  float n01 = noiseStable(c + ivec2(0, 1), salt);
  float n11 = noiseStable(c + ivec2(1, 1), salt);
  return mix(mix(n00, n10, s.x), mix(n01, n11, s.x), s.y);
}

// --- sampling --------------------------------------------------------------

vec2 texel() { return 1.0 / uResolution; }

/** Clamped RGB sample — matches sample_bilinear's CLAMP_TO_EDGE. */
vec3 tex(vec2 uv) { return texture(uTex, clamp(uv, texel() * 0.5, 1.0 - texel() * 0.5)).rgb; }

/** Offset sample, in pixels. */
vec3 texPx(vec2 uv, vec2 offsetPx) { return tex(uv + offsetPx * texel()); }

/**
 * The picture at \`uv\`, TRANSPARENT outside the frame.
 *
 * This is what makes every geometric kind work without a per-kind bounds test: a
 * slide, a flip and a spin all move the picture partly off-frame, and clamping to
 * the edge instead (which is what plain \`tex\` does) would smear the border pixels
 * across the empty half of the screen.
 */
vec4 picture(vec2 uv) {
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return vec4(tex(uv), inside);
}

/** Screen blend — adds light without ever darkening a pixel. */
vec3 screenBlend(vec3 base, vec3 add) {
  return 1.0 - (1.0 - base) * (1.0 - clamp(add, 0.0, 1.0));
}

/** Three-box-pass blur approximating a Gaussian, matching \`gaussian_blur\`. */
vec3 blurBox(vec2 uv, float radiusPx) {
  if (radiusPx <= 0.5) return tex(uv);
  vec3 total = vec3(0.0);
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      total += texPx(uv, vec2(float(x), float(y)) * radiusPx * 0.5);
    }
  }
  return total / 25.0;
}

// --- the reveal primitive --------------------------------------------------

/**
 * Alpha at position \`f\` (0..1 along a sweep) for reveal progress \`p\`.
 *
 * The exact mirror of \`wipe_alpha\` in render/transitions.py, including the
 * short-circuit at p >= 1: the edge overshoot to \`p * (1 + softness)\` is only
 * *exactly* clear in exact arithmetic, so without the guard the last frame of a
 * wipe leaves the trailing edge a hair transparent.
 *
 * Every wipe kind is this function over a different \`f\`, which is the entire
 * reason there are six wipe kinds and not six wipe implementations.
 */
float reveal(float f, float p) {
  if (p >= 1.0) return 1.0;
  float s = softness();
  float a = (p * (1.0 + s) - f) / s;
  return clamp(a, 0.0, 1.0);
}

/** {@link reveal} at the pass's own progress. */
float reveal(float f) { return reveal(f, uProgress); }
`;

/**
 * Closing boilerplate: runs the pass and writes straight-alpha RGBA.
 *
 * No intensity mix here — see the module note. The clamp is not optional: a pass
 * that screens light in (a flash, a leak) can legitimately compute above 1, and an
 * unclamped value writes garbage into an 8-bit target.
 */
export const TRANSITION_FRAGMENT_EPILOGUE = `
void main() {
  vec4 result = transition(vUv, uProgress);
  fragColor = vec4(clamp(result.rgb, 0.0, 1.0), clamp(result.a, 0.0, 1.0));
}`;
