/**
 * Shared GLSL preamble for the effect shaders (schema v13, ADR 0088).
 *
 * This is the GPU twin of
 * `engine/python/framepilot_engine/render/frame_effects/deterministic.py` and
 * '_common.py'. Every function here must behave identically to its numpy
 * counterpart, because the whole point of the effect system is that the preview
 * and the export show the same picture.
 *
 * The two places that took deliberate care:
 *
 * 1. 'hashU32' is an INTEGER bit-mix, not the usual
 *    `fract(sin(dot(p, k)) * 43758.5453)`. That idiom is the GLSL convention but
 *    'sin' is hardware-approximated — its low bits differ between GPU vendors and
 *    differ again from numpy — so grain built on it would visibly disagree
 *    between preview and render on the same frame. 'uint' arithmetic in GLSL ES
 *    3.0 wraps with exactly the same semantics as numpy 'uint32', so this mixer
 *    produces bit-identical output on both sides.
 *
 * 2. 'uNoiseFrame' is passed in as an *integer* already quantized by the CPU
 *    ('quantizeTime'), rather than derived from a float time here. A render steps
 *    exact frame times while a preview lands on whatever the compositor gives it;
 *    quantizing on both sides to the same 1/60s grid is what makes them agree.
 *
 * Sampling uses 'CLAMP_TO_EDGE', matching 'sample_bilinear''s clamp — wrapping
 * would fold content in from the opposite edge on any geometric effect.
 */

/**
 * Vertex shader for a full-screen triangle pair. Shared by every pass — the
 * effect chain only ever draws one quad, so this is compiled once and reused.
 */
export const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  // Straight clip-space to UV. NO V flip here, deliberately.
  //
  // A flip in the vertex shader is applied on EVERY pass, but it is only correct
  // for the first one — the pass reading the canvas-sourced texture. Every later
  // pass reads a framebuffer texture, which is already in GL's bottom-up
  // convention, so the flip compounds and the image comes out upside down
  // depending on how many effects are stacked.
  //
  // The orientation is corrected exactly once instead, at upload, with
  // UNPACK_FLIP_Y_WEBGL (see uploadSource). Source and framebuffer textures
  // then share one convention and any number of passes composes correctly.
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Fragment-shader preamble: uniforms and helpers every pass may use.
 *
 * Concatenated ahead of each pass body (see `glsl-passes.ts`), so a pass only
 * declares `vec3 effect(vec3 c)` and the machinery is identical everywhere.
 */
export const FRAGMENT_PREAMBLE = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTex;
/** Frame size in pixels. */
uniform vec2 uResolution;
/** Seconds since this layer's own start — NOT absolute time. */
uniform float uLocalTime;
/** This layer's duration in seconds. */
uniform float uDuration;
/** Position through the layer in [0,1] — the envelope parameter. */
uniform float uProgress;
/** CPU-quantized noise clock. See the module docstring. */
uniform int uNoiseFrame;
/**
 * Up to 8 clamped parameters, in the catalog's declared order for this kind.
 * A fixed-size array keeps every pass on one uniform layout, so the chain does
 * not need per-kind uniform bookkeeping.
 */
uniform float uParams[8];

const float PI = 3.141592653589793;
/** Rec.709 luma — the same weights the encoder and the numpy passes use. */
const vec3 REC709 = vec3(0.2126, 0.7152, 0.0722);

float luma(vec3 c) { return dot(c, REC709); }

// --- deterministic noise (mirrors deterministic.py) ------------------------

uint hashU32(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

/** White noise in [0,1) for integer cell coordinates. Mirrors noise01(). */
float noise01(ivec2 cell, int salt) {
  uint seed = uint(uNoiseFrame * 0x9E3779B1 + salt);
  uint key = hashU32(uint(cell.x) ^ hashU32(uint(cell.y) ^ seed));
  // High 24 bits: all a float32 holds exactly, and avoids the weak low bits of
  // any xor-multiply mixer. Divisor matches the Python side exactly.
  return float(key >> 8u) / 16777216.0;
}

/** Smooth value noise. Mirrors value_noise01(). */
float valueNoise01(vec2 p, float cell, int salt) {
  float scale = max(1e-3, cell);
  vec2 f = p / scale;
  vec2 i0 = floor(f);
  vec2 t = f - i0;
  // Smoothstep the interpolants: plain linear leaves visible grid creases.
  vec2 s = t * t * (3.0 - 2.0 * t);
  ivec2 c = ivec2(i0);
  float n00 = noise01(c, salt);
  float n10 = noise01(c + ivec2(1, 0), salt);
  float n01 = noise01(c + ivec2(0, 1), salt);
  float n11 = noise01(c + ivec2(1, 1), salt);
  return mix(mix(n00, n10, s.x), mix(n01, n11, s.x), s.y);
}

// --- sampling & geometry ---------------------------------------------------

/** Texel size in UV units. */
vec2 texel() { return 1.0 / uResolution; }

/** Clamped sample — matches sample_bilinear's CLAMP_TO_EDGE behaviour. */
vec3 tex(vec2 uv) { return texture(uTex, clamp(uv, texel() * 0.5, 1.0 - texel() * 0.5)).rgb; }

/** Offset sample, in pixels. */
vec3 texPx(vec2 uv, vec2 offsetPx) { return tex(uv + offsetPx * texel()); }

/**
 * UV centred on (0,0) in [-1,1], aspect-corrected on the short axis — mirrors
 * '_centered_uv'. This is what keeps a fisheye circular on a 9:16 frame.
 */
vec2 centeredUv(vec2 uv) {
  float aspect = uResolution.x / max(1.0, uResolution.y);
  vec2 c = (uv - 0.5) * 2.0;
  if (aspect >= 1.0) c.x *= aspect; else c.y /= aspect;
  return c;
}

/** Inverse of centeredUv — mirrors \`_uv_to_pixels\` in UV space. */
vec2 uncenteredUv(vec2 c) {
  float aspect = uResolution.x / max(1.0, uResolution.y);
  if (aspect >= 1.0) c.x /= aspect; else c.y *= aspect;
  return c * 0.5 + 0.5;
}

/** Fully-saturated RGB for a hue in degrees. Mirrors hue_to_rgb(). */
vec3 hue2rgb(float degrees) {
  float h = mod(degrees, 360.0) / 60.0;
  float x = 1.0 - abs(mod(h, 2.0) - 1.0);
  if (h < 1.0) return vec3(1.0, x, 0.0);
  if (h < 2.0) return vec3(x, 1.0, 0.0);
  if (h < 3.0) return vec3(0.0, 1.0, x);
  if (h < 4.0) return vec3(0.0, x, 1.0);
  if (h < 5.0) return vec3(x, 0.0, 1.0);
  return vec3(1.0, 0.0, x);
}

/** Screen blend — adds light without ever darkening a pixel. */
vec3 screen(vec3 base, vec3 add) { return 1.0 - (1.0 - base) * (1.0 - clamp(add, 0.0, 1.0)); }

/**
 * Three-box-pass blur approximating a Gaussian, matching \`gaussian_blur\`.
 *
 * A true Gaussian kernel here and boxes on the numpy side would NOT match, so
 * both run the same three-pass box. Tap count is fixed so the loop unrolls.
 */
vec3 blurBox(vec2 uv, float radiusPx) {
  if (radiusPx <= 0.5) return tex(uv);
  vec3 total = vec3(0.0);
  float count = 0.0;
  // 5x5 taps spread over the radius: enough to read as a smooth blur at the
  // catalog's 64px maximum without a 4096-tap loop.
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      total += texPx(uv, vec2(float(x), float(y)) * radiusPx * 0.5);
      count += 1.0;
    }
  }
  return total / count;
}

/** Sobel gradient magnitude of luma, normalized to ~[0,1]. Mirrors _sobel(). */
float sobel(vec2 uv) {
  float tl = luma(texPx(uv, vec2(-1.0, -1.0)));
  float tc = luma(texPx(uv, vec2(0.0, -1.0)));
  float tr = luma(texPx(uv, vec2(1.0, -1.0)));
  float ml = luma(texPx(uv, vec2(-1.0, 0.0)));
  float mr = luma(texPx(uv, vec2(1.0, 0.0)));
  float bl = luma(texPx(uv, vec2(-1.0, 1.0)));
  float bc = luma(texPx(uv, vec2(0.0, 1.0)));
  float br = luma(texPx(uv, vec2(1.0, 1.0)));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  // /4 because the Sobel kernel sums to 4 on a full-contrast edge.
  return clamp(length(vec2(gx, gy)) / 4.0, 0.0, 1.0);
}
`;

/**
 * Closing boilerplate: calls the pass's `effect()` and writes the result.
 *
 * 'intensity' is mixed HERE rather than in each pass, mirroring how the Python
 * dispatcher does it — so a pass implements only its full-strength look and the
 * strength dial works everywhere for free.
 */
export const FRAGMENT_EPILOGUE = `
uniform float uIntensity;
void main() {
  vec3 src = tex(vUv);
  vec3 out3 = effect(src, vUv);
  fragColor = vec4(clamp(mix(src, out3, uIntensity), 0.0, 1.0), 1.0);
}`;

/** Max params a single kind may declare — the 'uParams' array size. */
export const MAX_PARAMS = 8;
