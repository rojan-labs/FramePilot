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
uniform int u_crv;
uniform int u_cbu;
uniform int u_cgu;
uniform int u_cgv;
uniform int u_yOffset;
uniform int u_cy;
uniform int u_yb;
out vec4 o_color;
int yTable(int index) {
  return clamp((u_yb + index * u_cy + 32768) >> 16, 0, 255);
}
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
  y = y >> 19;
  u = clamp(u >> 19, 0, 255);
  v = clamp(v >> 19, 0, 255);
  int r = u_yOffset - (u_crv >> 9) + ((v * u_crv) >> 16) + y;
  int b = u_yOffset - (u_cbu >> 9) + ((u * u_cbu) >> 16) + y;
  int g = u_yOffset - (u_cgu >> 9) + ((u * u_cgu) >> 16) - (u_cgv >> 9) + ((v * u_cgv) >> 16) + y;
  o_color = vec4(float(yTable(r)), float(yTable(g)), float(yTable(b)), 255.0) / 255.0;
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
