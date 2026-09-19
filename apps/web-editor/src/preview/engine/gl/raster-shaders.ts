/**
 * GLSL for the layer compositor's raster passes (PX2.1, PX2.7).
 *
 * Every pass is integer arithmetic on exact texel values (`texelFetch`, never filtering), so the
 * GPU computes what `engine/raster/swscale.ts` and `engine/raster/pil.ts` compute on the CPU —
 * and those are pinned bit-exact to FFmpeg and Pillow. Conventions:
 *
 * - Texture row 0 is the image's TOP row (uploads never flip; framebuffer passes write row
 *   `gl_FragCoord.y` of their target). Only {@link PRESENT_FRAGMENT} flips, for the canvas.
 * - 8-bit colour lives in `RGBA8` (unorm) and is read back to integers with `* 255 + 0.5`.
 * - Loop bounds are uniforms capped by a constant so strict drivers accept them.
 */

/** Largest tap count any filter table may carry (a 1:12 downscale with Lanczos). */
export const MAX_TAPS = 96;

export const FULLSCREEN_VERTEX = `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
precision highp isampler2D;
const int MAX_TAPS = ${MAX_TAPS};
`;

/**
 * swscale `hScale8To15_c` over one plane: `min((Σ src[pos + j] · coeff[j]) >> 7, 32767)`.
 * `u_filter` is `dstSize × (size + 1)`: row 0 the start positions, rows 1.. the coefficients.
 */
export const SWS_HORIZONTAL_FRAGMENT = `${HEADER}
uniform usampler2D u_plane;
uniform isampler2D u_filter;
uniform int u_size;
out ivec4 o_value;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int pos = texelFetch(u_filter, ivec2(p.x, 0), 0).r;
  int acc = 0;
  for (int j = 0; j < MAX_TAPS; j++) {
    if (j >= u_size) break;
    acc += int(texelFetch(u_plane, ivec2(pos + j, p.y), 0).r) * texelFetch(u_filter, ivec2(p.x, j + 1), 0).r;
  }
  int v = acc >> 7;
  o_value = ivec4(min(v, 32767), 0, 0, 1);
}
`;

/**
 * The RGB24 lookup tables of `ff_yuv2rgb_c_init_tables` as arithmetic (`swscale.ts#swsTableToRgb`):
 * one copy, shared by the scaled path and the unscaled C converter (MK6.4), so the two cannot
 * disagree about a table entry. Declares its uniforms; `tablesRgb` takes 8-bit Y, U, V.
 */
const SWS_RGB_TABLES_GLSL = `
uniform int u_crv;
uniform int u_cbu;
uniform int u_cgu;
uniform int u_cgv;
uniform int u_yOffset;
uniform int u_cy;
uniform int u_yb;
int yTable(int index) {
  return clamp((u_yb + index * u_cy + 32768) >> 16, 0, 255);
}
vec4 tablesRgb(int y, int u, int v) {
  int r = u_yOffset - (u_crv >> 9) + ((v * u_crv) >> 16) + y;
  int b = u_yOffset - (u_cbu >> 9) + ((u * u_cbu) >> 16) + y;
  int g = u_yOffset - (u_cgu >> 9) + ((u * u_cgu) >> 16) - (u_cgv >> 9) + ((v * u_cgv) >> 16) + y;
  return vec4(float(yTable(r)), float(yTable(g)), float(yTable(b)), 255.0) / 255.0;
}
`;

/**
 * swscale's vertical filter inside `yuv2rgb_X_c_template` plus the RGB24 lookup tables.
 * Luma lines are `dstW × srcH`, chroma lines `ceil(dstW/2) × chromaSrcH`; each pair of output
 * pixels shares chroma column `x >> 1`.
 */
export const SWS_VERTICAL_RGB_FRAGMENT = `${HEADER}
uniform isampler2D u_lumaLines;
uniform isampler2D u_uLines;
uniform isampler2D u_vLines;
uniform isampler2D u_lumaFilter;
uniform isampler2D u_chromaFilter;
uniform int u_lumaSize;
uniform int u_chromaSize;
${SWS_RGB_TABLES_GLSL}
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int lumaPos = texelFetch(u_lumaFilter, ivec2(p.y, 0), 0).r;
  int y = 1 << 18;
  for (int j = 0; j < MAX_TAPS; j++) {
    if (j >= u_lumaSize) break;
    y += texelFetch(u_lumaLines, ivec2(p.x, lumaPos + j), 0).r * texelFetch(u_lumaFilter, ivec2(p.y, j + 1), 0).r;
  }
  int chromaPos = texelFetch(u_chromaFilter, ivec2(p.y, 0), 0).r;
  int cx = p.x >> 1;
  int u = 1 << 18;
  int v = 1 << 18;
  for (int j = 0; j < MAX_TAPS; j++) {
    if (j >= u_chromaSize) break;
    int c = texelFetch(u_chromaFilter, ivec2(p.y, j + 1), 0).r;
    u += texelFetch(u_uLines, ivec2(cx, chromaPos + j), 0).r * c;
    v += texelFetch(u_vLines, ivec2(cx, chromaPos + j), 0).r * c;
  }
  o_color = tablesRgb(y >> 19, clamp(u >> 19, 0, 255), clamp(v >> 19, 0, 255));
}
`;

/**
 * The unscaled C converter (`yuv2rgb_c_24_rgb`, MK6.4): nearest (2×2) chroma straight into the
 * lookup tables. What an export host without a SIMD `yuv420p → rgb24` converter runs — the
 * macOS arm64 ffmpeg MoviePy uses — in place of {@link SWS_UNSCALED_FRAGMENT}.
 */
export const SWS_UNSCALED_TABLES_FRAGMENT = `${HEADER}
uniform usampler2D u_y;
uniform usampler2D u_u;
uniform usampler2D u_v;
${SWS_RGB_TABLES_GLSL}
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int y = int(texelFetch(u_y, p, 0).r);
  int u = int(texelFetch(u_u, p / 2, 0).r);
  int v = int(texelFetch(u_v, p / 2, 0).r);
  o_color = tablesRgb(y, u, v);
}
`;

/** The x86 unscaled converter (`yuv420_rgb24`): `pmulhw` arithmetic, 2×2 chroma. */
export const SWS_UNSCALED_FRAGMENT = `${HEADER}
uniform usampler2D u_y;
uniform usampler2D u_u;
uniform usampler2D u_v;
uniform int u_yCoeff;
uniform int u_yOffset;
uniform int u_vrCoeff;
uniform int u_ubCoeff;
uniform int u_ugCoeff;
uniform int u_vgCoeff;
out vec4 o_color;
int pmulhw(int a, int b) { return (a * b) >> 16; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int yv = int(texelFetch(u_y, p, 0).r);
  int uv = int(texelFetch(u_u, p / 2, 0).r) * 8 - 1024;
  int vv = int(texelFetch(u_v, p / 2, 0).r) * 8 - 1024;
  int luma = pmulhw(max(0, yv * 8 - u_yOffset), u_yCoeff);
  int r = clamp(luma + pmulhw(vv, u_vrCoeff), 0, 255);
  int g = clamp(luma + pmulhw(uv, u_ugCoeff) + pmulhw(vv, u_vgCoeff), 0, 255);
  int b = clamp(luma + pmulhw(uv, u_ubCoeff), 0, 255);
  o_color = vec4(float(r), float(g), float(b), 255.0) / 255.0;
}
`;

/**
 * Copy a sub-rectangle (a crop) and optionally replace alpha with a constant 8-bit mask value.
 * `u_alpha8 < 0` keeps the source alpha.
 */
export const COPY_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform ivec2 u_origin;
uniform int u_alpha8;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_source, u_origin + p, 0);
  if (u_alpha8 >= 0) c.a = float(u_alpha8) / 255.0;
  o_color = c;
}
`;

/**
 * Pillow `_ImagingResample{Horizontal,Vertical}_8bpc`, every channel independently.
 * `u_coefficients` is `outSize × (ksize + 2)`: rows 0/1 hold `xmin`/count, rows 2.. the
 * 22-bit weights.
 */
export const PIL_RESAMPLE_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform isampler2D u_coefficients;
uniform int u_axis;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int index = u_axis == 0 ? p.x : p.y;
  int first = texelFetch(u_coefficients, ivec2(index, 0), 0).r;
  int count = texelFetch(u_coefficients, ivec2(index, 1), 0).r;
  ivec4 sum = ivec4(1 << 21);
  for (int k = 0; k < MAX_TAPS; k++) {
    if (k >= count) break;
    ivec2 q = u_axis == 0 ? ivec2(first + k, p.y) : ivec2(p.x, first + k);
    ivec4 texel = ivec4(texelFetch(u_source, q, 0) * 255.0 + 0.5);
    sum += texel * texelFetch(u_coefficients, ivec2(index, k + 2), 0).r;
  }
  o_color = vec4(clamp(sum >> 22, ivec4(0), ivec4(255))) / 255.0;
}
`;

/**
 * Pillow `ImagingAlphaComposite` of one placed layer over the accumulated frame, integer
 * arithmetic throughout. Outside the layer's rectangle the frame passes through.
 */
export const COMPOSITE_FRAGMENT = `${HEADER}
uniform sampler2D u_frame;
uniform sampler2D u_layer;
uniform ivec2 u_position;
uniform ivec2 u_size;
out vec4 o_color;
uint div255(uint a) { return ((a >> 8u) + a) >> 8u; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 dst = uvec4(texelFetch(u_frame, p, 0) * 255.0 + 0.5);
  ivec2 q = p - u_position;
  if (q.x < 0 || q.y < 0 || q.x >= u_size.x || q.y >= u_size.y) {
    o_color = vec4(dst) / 255.0;
    return;
  }
  uvec4 src = uvec4(texelFetch(u_layer, q, 0) * 255.0 + 0.5);
  if (src.a == 0u) {
    o_color = vec4(dst) / 255.0;
    return;
  }
  uint blend = dst.a * (255u - src.a);
  uint outA255 = src.a * 255u + blend;
  uint coef1 = src.a * 255u * 255u * 128u / outA255;
  uint coef2 = 255u * 128u - coef1;
  o_color = vec4(
    float(div255(src.r * coef1 + dst.r * coef2 + (128u << 7u)) >> 7u),
    float(div255(src.g * coef1 + dst.g * coef2 + (128u << 7u)) >> 7u),
    float(div255(src.b * coef1 + dst.b * coef2 + (128u << 7u)) >> 7u),
    float(div255(outA255 + 128u))
  ) / 255.0;
}
`;

/** Clear the frame to the export's background (opaque black) in one pass. */
export const FILL_FRAGMENT = `${HEADER}
uniform vec4 u_color;
out vec4 o_color;
void main() {
  o_color = u_color;
}
`;

/** Show the finished frame: texture row 0 (top) goes to the top of the canvas. */
export const PRESENT_FRAGMENT = `${HEADER}
uniform sampler2D u_frame;
uniform int u_height;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o_color = texelFetch(u_frame, ivec2(p.x, u_height - 1 - p.y), 0);
}
`;

/**
 * `render/color.py` `apply_color_grade` on an 8-bit layer (alpha passes through): exposure →
 * white balance → contrast → shadows/highlights → saturation, then `round(clip(x) * 255)`.
 * float32 throughout, as numpy's.
 */
export const GRADE_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
uniform float u_tint;
uniform float u_shadows;
uniform float u_highlights;
out vec4 o_color;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 texel = texelFetch(u_source, p, 0);
  vec3 rgb = floor(texel.rgb * 255.0 + 0.5) / 255.0;
  if (u_exposure != 0.0) rgb *= pow(2.0, u_exposure);
  if (u_temperature != 0.0) {
    rgb.r *= 1.0 + 0.3 * u_temperature;
    rgb.b *= 1.0 - 0.3 * u_temperature;
  }
  if (u_tint != 0.0) rgb.g *= 1.0 + 0.3 * u_tint;
  if (u_contrast != 0.0) rgb = (rgb - 0.5) * (1.0 + u_contrast) + 0.5;
  if (u_shadows != 0.0 || u_highlights != 0.0) {
    float lum = clamp(dot(clamp(rgb, 0.0, 1.0), LUMA), 0.0, 1.0);
    float delta = 0.5 * (u_shadows * (1.0 - lum) * (1.0 - lum) + u_highlights * lum * lum);
    rgb += delta;
  }
  if (u_saturation != 0.0) {
    float lum = dot(rgb, LUMA);
    rgb = lum + (rgb - lum) * (1.0 + u_saturation);
  }
  o_color = vec4(floor(clamp(rgb, 0.0, 1.0) * 255.0 + 0.5) / 255.0, texel.a);
}
`;

/** `apply_lut`: trilinear lookup in an `RGBA32F` 3D table indexed `[r, g, b]`. */
export const LUT_FRAGMENT = `${HEADER}
precision highp sampler3D;
uniform sampler2D u_source;
uniform sampler3D u_table;
uniform int u_size;
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;
out vec4 o_color;
vec3 cell(ivec3 i) { return texelFetch(u_table, i, 0).rgb; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 texel = texelFetch(u_source, p, 0);
  vec3 rgb = floor(texel.rgb * 255.0 + 0.5) / 255.0;
  vec3 coords = (clamp(rgb, u_domainMin, u_domainMax) - u_domainMin) / (u_domainMax - u_domainMin);
  vec3 pos = coords * float(u_size - 1);
  ivec3 lo = ivec3(floor(pos));
  ivec3 hi = min(lo + 1, ivec3(u_size - 1));
  vec3 f = pos - vec3(lo);
  vec3 c00 = cell(ivec3(lo.r, lo.g, lo.b)) * (1.0 - f.r) + cell(ivec3(hi.r, lo.g, lo.b)) * f.r;
  vec3 c10 = cell(ivec3(lo.r, hi.g, lo.b)) * (1.0 - f.r) + cell(ivec3(hi.r, hi.g, lo.b)) * f.r;
  vec3 c01 = cell(ivec3(lo.r, lo.g, hi.b)) * (1.0 - f.r) + cell(ivec3(hi.r, lo.g, hi.b)) * f.r;
  vec3 c11 = cell(ivec3(lo.r, hi.g, hi.b)) * (1.0 - f.r) + cell(ivec3(hi.r, hi.g, hi.b)) * f.r;
  vec3 c0 = c00 * (1.0 - f.g) + c10 * f.g;
  vec3 c1 = c01 * (1.0 - f.g) + c11 * f.g;
  vec3 outRgb = c0 * (1.0 - f.b) + c1 * f.b;
  o_color = vec4(floor(clamp(outRgb, 0.0, 1.0) * 255.0 + 0.5) / 255.0, texel.a);
}
`;

/**
 * `_blend_layer_over`: the running frame is the base, the placed layer the blend, and its mask
 * weights the blended colour: `base·(1−α) + clip(f(base, blend))·α`, truncated to 8 bits.
 * Mode numbers follow {@link BLEND_MODE_INDEX}.
 */
export const BLEND_FRAGMENT = `${HEADER}
uniform sampler2D u_frame;
uniform sampler2D u_layer;
uniform ivec2 u_position;
uniform ivec2 u_size;
uniform int u_mode;
out vec4 o_color;
vec3 blendOf(vec3 a, vec3 b) {
  if (u_mode == 1) return a * b;
  if (u_mode == 2) return 1.0 - (1.0 - a) * (1.0 - b);
  if (u_mode == 3) return min(a, b);
  if (u_mode == 4) return max(a, b);
  if (u_mode == 5) return mix(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, vec3(lessThan(b, vec3(0.5))));
  if (u_mode == 6) return mix(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, vec3(lessThan(a, vec3(0.5))));
  if (u_mode == 7) {
    vec3 denom = max(1.0 - b, vec3(1e-6));
    return mix(min(vec3(1.0), a / denom), vec3(1.0), vec3(greaterThanEqual(b, vec3(1.0))));
  }
  if (u_mode == 8) {
    vec3 denom = max(b, vec3(1e-6));
    return mix(1.0 - min(vec3(1.0), (1.0 - a) / denom), vec3(0.0), vec3(lessThanEqual(b, vec3(0.0))));
  }
  if (u_mode == 9) {
    vec3 d = mix(sqrt(a), ((16.0 * a - 12.0) * a + 4.0) * a, vec3(lessThanEqual(a, vec3(0.25))));
    return mix(a + (2.0 * b - 1.0) * (d - a), a - (1.0 - 2.0 * b) * a * (1.0 - a), vec3(lessThanEqual(b, vec3(0.5))));
  }
  if (u_mode == 10) return abs(a - b);
  if (u_mode == 11) return a + b - 2.0 * a * b;
  return b;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 base = floor(texelFetch(u_frame, p, 0).rgb * 255.0 + 0.5) / 255.0;
  ivec2 q = p - u_position;
  float alpha = 0.0;
  vec3 blend = vec3(0.0);
  if (q.x >= 0 && q.y >= 0 && q.x < u_size.x && q.y < u_size.y) {
    vec4 layer = floor(texelFetch(u_layer, q, 0) * 255.0 + 0.5) / 255.0;
    alpha = layer.a;
    if (layer.a > 0.0) blend = layer.rgb;
  }
  vec3 blended = clamp(blendOf(base, blend), 0.0, 1.0);
  vec3 outRgb = base * (1.0 - alpha) + blended * alpha;
  // numpy truncates the float64 product; nudge float32 over representation error first.
  o_color = vec4(floor(clamp(outRgb * 255.0 + 1e-3, 0.0, 255.0)) / 255.0, 1.0);
}
`;

/** Blend mode → {@link BLEND_FRAGMENT} `u_mode` (`render/blend.py` keys). */
export const BLEND_MODE_INDEX: Readonly<Record<string, number>> = {
  multiply: 1,
  screen: 2,
  darken: 3,
  lighten: 4,
  overlay: 5,
  'hard-light': 6,
  'color-dodge': 7,
  'color-burn': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
};

/**
 * `_attach_mask`'s alpha for one layer at its own (pre-placement) size: opacity × the legacy
 * wipe band, stored as the 8-bit value compositing truncates it to. `u_wipeAxis`: 0 none,
 * 1 x, 2 y.
 */
export const ALPHA_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform float u_opacity;
uniform int u_wipeAxis;
uniform bool u_wipeInverted;
uniform float u_wipeEdge;
uniform float u_wipeFeather;
uniform bool u_hasMask;
uniform float u_maskScale;
uniform highp usampler2D u_mask;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_source, 0);
  vec4 texel = texelFetch(u_source, p, 0);
  float alpha = u_opacity;
  if (u_hasMask) alpha *= float(texelFetch(u_mask, p, 0).r) / 255.0 * u_maskScale;
  if (u_wipeAxis != 0) {
    float extent = float(u_wipeAxis == 1 ? size.x : size.y);
    float f = (float(u_wipeAxis == 1 ? p.x : p.y) + 0.5) / extent;
    if (u_wipeInverted) f = 1.0 - f;
    alpha *= clamp((u_wipeEdge - f) / u_wipeFeather, 0.0, 1.0);
  }
  o_color = vec4(texel.rgb, floor(clamp(alpha, 0.0, 1.0) * 255.0 + 1e-4) / 255.0);
}
`;

/**
 * An effect limited by a mask (`render/mask_stack.py#mix_by_alpha`): the effect's output mixed
 * with its input by the stack alpha, RGB only, input alpha kept. A quantised stack
 * (`u_scale == 1`, alpha `q / 255`) is mixed in integers: `rint((255 o + (e - o) q) / 255)` has
 * no ties, so it is `(2n + 255) / 510`. A lone legacy mask carries a float factor and is mixed
 * in float with round-half-even.
 */
export const MASK_MIX_FRAGMENT = `${HEADER}
uniform sampler2D u_original;
uniform sampler2D u_effected;
uniform highp usampler2D u_mask;
uniform float u_scale;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 original = texelFetch(u_original, p, 0);
  ivec3 o = ivec3(floor(original.rgb * 255.0 + 0.5));
  ivec3 e = ivec3(floor(texelFetch(u_effected, p, 0).rgb * 255.0 + 0.5));
  int q = int(texelFetch(u_mask, p, 0).r);
  vec3 mixed;
  if (u_scale == 1.0) {
    ivec3 n = o * 255 + (e - o) * q;
    mixed = vec3((n * 2 + 255) / 510);
  } else {
    float a = float(q) / 255.0 * u_scale;
    mixed = clamp(roundEven(vec3(o) + vec3(e - o) * a), 0.0, 255.0);
  }
  o_color = vec4(mixed / 255.0, original.a);
}
`;

/**
 * MK3.3 mask debug views on one layer. Mode 1 (overlay): the picture, with what the mask removes
 * tinted toward the mask colour (`u_strength` at alpha 0). Mode 2 (mask only): the stack's alpha
 * as an opaque grey picture. Never part of a program frame.
 */
export const MASK_VIEW_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform highp usampler2D u_mask;
uniform int u_mode;
uniform float u_scale;
uniform vec3 u_color;
uniform float u_strength;
uniform int u_outline;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 texel = texelFetch(u_source, p, 0);
  float a = clamp(float(texelFetch(u_mask, p, 0).r) / 255.0 * u_scale, 0.0, 1.0);
  ivec2 size = textureSize(u_source, 0);
  bool edge = u_outline > 0 &&
    (p.x < u_outline || p.y < u_outline || p.x >= size.x - u_outline || p.y >= size.y - u_outline);
  if (u_mode == 3 && edge) {
    o_color = vec4(u_color, 1.0);
  } else if (u_mode == 2) {
    o_color = vec4(vec3(a), 1.0);
  } else {
    o_color = vec4(mix(texel.rgb, u_color, (1.0 - a) * u_strength), texel.a);
  }
}
`;

/**
 * MK3.3 checkerboard backdrop (16 px squares, two neutral greys) for the cut-out view. Plain
 * constants rather than design tokens: GL cannot read CSS, and a transparency checkerboard is a
 * universal convention, not a brand surface.
 */
export const CHECKERBOARD_FRAGMENT = `${HEADER}
out vec4 o_color;
void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy) / 16;
  float shade = ((cell.x + cell.y) % 2 == 0) ? 0.8 : 0.6;
  o_color = vec4(vec3(shade), 1.0);
}
`;

/**
 * Pillow `Image.rotate(angle, BICUBIC, expand=False)` through `ImagingGenericTransform`:
 * the inverse affine map at pixel centres, Pillow's own cubic (`BICUBIC` macro), edge-clamped
 * taps, zero outside the source, truncated to 8 bits. Every channel, alpha included (MoviePy
 * rotates the mask the same way).
 */
export const ROTATE_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform vec3 u_rowX;
uniform vec3 u_rowY;
out vec4 o_color;
vec4 cubic(vec4 v1, vec4 v2, vec4 v3, vec4 v4, float d) {
  vec4 p1 = v2;
  vec4 p2 = -v1 + v3;
  vec4 p3 = 2.0 * (v1 - v2) + v3 - v4;
  vec4 p4 = -v1 + v2 - v3 + v4;
  return p1 + d * (p2 + d * (p3 + d * p4));
}
vec4 px(int x, int y, ivec2 size) {
  return floor(texelFetch(u_source, ivec2(clamp(x, 0, size.x - 1), y), 0) * 255.0 + 0.5);
}
vec4 row(int y, int x, float dx, ivec2 size) {
  return cubic(px(x, y, size), px(x + 1, y, size), px(x + 2, y, size), px(x + 3, y, size), dx);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_source, 0);
  vec3 c = vec3(float(p.x) + 0.5, float(p.y) + 0.5, 1.0);
  float xin = dot(u_rowX, c);
  float yin = dot(u_rowY, c);
  if (xin < 0.0 || xin >= float(size.x) || yin < 0.0 || yin >= float(size.y)) {
    o_color = vec4(0.0);
    return;
  }
  xin -= 0.5;
  yin -= 0.5;
  int x = int(floor(xin));
  int y = int(floor(yin));
  float dx = xin - float(x);
  float dy = yin - float(y);
  x -= 1;
  y -= 1;
  vec4 v1 = row(clamp(y, 0, size.y - 1), x, dx, size);
  vec4 v2 = (y + 1 >= 0 && y + 1 < size.y) ? row(y + 1, x, dx, size) : v1;
  vec4 v3 = (y + 2 >= 0 && y + 2 < size.y) ? row(y + 2, x, dx, size) : v2;
  vec4 v4 = (y + 3 >= 0 && y + 3 < size.y) ? row(y + 3, x, dx, size) : v3;
  vec4 v = cubic(v1, v2, v3, v4, dy);
  o_color = clamp(floor(v), 0.0, 255.0) / 255.0;
}
`;

/**
 * One Pillow `ImagingHorizontalBoxBlur` pass (u_axis 0) or its transposed vertical twin
 * (u_axis 1): edge-clamped window sum times `ww`, the two far taps times `fw`, `>> 24` with
 * rounding. RGB only (the export blurs the RGB frame; the mask is separate).
 */
export const PIL_BOX_BLUR_FRAGMENT = `${HEADER}
uniform sampler2D u_source;
uniform int u_axis;
uniform int u_radius;
uniform uint u_ww;
uniform uint u_fw;
out vec4 o_color;
uvec3 px(ivec2 p, int k, ivec2 size) {
  ivec2 q = u_axis == 0 ? ivec2(clamp(p.x + k, 0, size.x - 1), p.y) : ivec2(p.x, clamp(p.y + k, 0, size.y - 1));
  return uvec3(texelFetch(u_source, q, 0).rgb * 255.0 + 0.5);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_source, 0);
  uvec3 acc = uvec3(0u);
  for (int k = -512; k <= 512; k++) {
    if (k < -u_radius || k > u_radius) continue;
    acc += px(p, k, size);
  }
  uvec3 bulk = acc * u_ww + (px(p, -u_radius - 1, size) + px(p, u_radius + 1, size)) * u_fw;
  uvec3 v = (bulk + uvec3(1u << 23u)) >> 24u;
  o_color = vec4(vec3(v & uvec3(255u)) / 255.0, texelFetch(u_source, p, 0).a);
}
`;

// --- Mask stacks built on the GPU (MK6.1) -----------------------------------------------------
//
// A stack that holds a `key` cannot be rastered on the CPU: the key reads the picture, so its
// alpha changes every frame and there is nothing to cache. Such a stack is combined on the GPU
// instead — one float target accumulating layer by layer, quantised ONCE at the end, exactly as
// `stack_alpha` quantises once — and the result is written to `R8UI` so it binds where an
// uploaded CPU raster binds (`ALPHA_FRAGMENT`, `MASK_MIX_FRAGMENT`, `MASK_VIEW_FRAGMENT` all
// sample `usampler2D u_mask`).

/**
 * `combine(accumulated, mask, mode)`: add 0 · subtract 1 · intersect 2 · difference 3 ·
 * lighten 4 · darken 5. The stack starts all-zero, so a stack that begins with `subtract` is
 * honestly empty.
 */
export const MASK_COMBINE_FRAGMENT = `${HEADER}
uniform sampler2D u_accumulated;
uniform sampler2D u_layer;
uniform int u_mode;
/** 1 for the first layer: the stack starts all-zero and there is nothing to sample yet. */
uniform int u_first;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float a = u_first == 1 ? 0.0 : texelFetch(u_accumulated, p, 0).r;
  float m = texelFetch(u_layer, p, 0).r;
  float result;
  if (u_mode == 1) result = max(a - m, 0.0);
  else if (u_mode == 2) result = a * m;
  else if (u_mode == 3) result = abs(a - m);
  else if (u_mode == 4) result = max(a, m);
  else if (u_mode == 5) result = min(a, m);
  else result = min(a + m, 1.0);
  o_color = vec4(result, 0.0, 0.0, 1.0);
}
`;

/**
 * `quantize_alpha`: `rint(a * 255)` with numpy's round-half-EVEN, into the integer coverage
 * texture the mask shaders sample. Round-half-up here would disagree with the export on every
 * value that lands exactly between two bytes, which a flat qualifier produces by the thousand.
 */
export const MASK_QUANTIZE_FRAGMENT = `${HEADER}
uniform sampler2D u_alpha;
out uvec4 o_value;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float scaled = clamp(texelFetch(u_alpha, p, 0).r, 0.0, 1.0) * 255.0;
  float low = floor(scaled);
  float fraction = scaled - low;
  float rounded;
  if (fraction > 0.5) rounded = low + 1.0;
  else if (fraction < 0.5) rounded = low;
  else rounded = mod(low, 2.0) == 0.0 ? low : low + 1.0;
  o_value = uvec4(uint(rounded), 0u, 0u, 255u);
}
`;
