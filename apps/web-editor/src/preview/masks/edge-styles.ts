/**
 * Cut-out edge styles in the monitor (MK9.2): the outline, glow and shadow drawn around what a
 * clip's alpha mask stack keeps. The twin of `engine/python/framepilot_engine/render/edge_styles.py`.
 *
 * The rule, step for step as the export runs it:
 *
 * 1. the cut-out is where the stack alpha is at least one half;
 * 2. `d` is the exact Euclidean distance (raster pixels, centre to centre) to the nearest cut-out
 *    pixel, from a separable search bounded by the style's reach `R`: per row the nearest cut-out
 *    column `g` within `R` ({@link EDGE_ROW_FRAGMENT}), then `min over |dy| <= R of g² + dy²`
 *    ({@link EDGE_COLUMN_FRAGMENT}). Integers until one `sqrt`, so the GPU finds the same `d`;
 * 3. stroke alpha `clamp(w + 0.5 − d, 0, 1)`, glow and shadow `(1 − t)²` for `t = d / (r + 1)`,
 *    a shadow measuring `d` from the cut-out moved by its offset (round half to even);
 * 4. times the style's opacity and the clip's; shadow, glow, stroke stack bottom to top in
 *    premultiplied colour and the picture goes over them ({@link EDGE_COMPOSITE_FRAGMENT}).
 *
 * The CPU functions here ({@link edgeDistanceField}, {@link applyEdgeStylesCpu}) run the rule in
 * float64 and are pinned byte for byte to the engine by `tests/fixtures/mask-raster/edge-styles.json`;
 * the shaders are float32 and are judged by the PX4 oracle's `alpha/edge-*` rows at the unchanged
 * gates, like the key and track matte passes.
 */
import type { FramePlanEdgeStyle } from '@framepilot/editor-core';

/** The kinds in stacking order, as the composite shader numbers them (`EDGE_STYLE_KINDS`). */
export const EDGE_KIND_INDEX: Readonly<Record<FramePlanEdgeStyle['kind'], number>> = {
  shadow: 0,
  glow: 1,
  stroke: 2,
};

/**
 * The widest search the monitor runs, raster pixels. Beyond it the passes would cost more than a
 * frame; a style that needs more is left out on the monitor (the export still draws it) and the
 * monitor says so in its log. No catalog setting reaches it at a decode size at or below the
 * source size.
 */
export const EDGE_PREVIEW_MAX_REACH = 256;

/** Up to this many styles draw at once: one per kind. */
export const EDGE_MAX_STYLES = 3;

/** `np.rint`: round half to even. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `EdgeStyle.extent`: how far a style reaches past the cut-out, raster pixels. */
export function edgeExtent(style: FramePlanEdgeStyle, scale: number): number {
  if (style.kind === 'stroke') return style.params.widthPx! * scale + 0.5;
  if (style.kind === 'glow') return style.params.radiusPx! * scale + 1.0;
  return style.params.softnessPx! * scale + 1.0;
}

/** `EdgeStyle.reach`: the distance search bound. */
export function edgeReach(style: FramePlanEdgeStyle, scale: number): number {
  return Math.max(1, Math.ceil(edgeExtent(style, scale)));
}

/** `EdgeStyle.shift`: a shadow's whole-pixel offset. */
export function edgeShift(style: FramePlanEdgeStyle, scale: number): readonly [number, number] {
  if (style.kind !== 'shadow') return [0, 0];
  return [
    roundHalfEven(style.params.offsetXPx! * scale),
    roundHalfEven(style.params.offsetYPx! * scale),
  ];
}

/** The size the style alpha divides by: stroke width, glow radius or shadow softness (raster px). */
export function edgeSize(style: FramePlanEdgeStyle, scale: number): number {
  const name =
    style.kind === 'stroke' ? 'widthPx' : style.kind === 'glow' ? 'radiusPx' : 'softnessPx';
  return style.params[name]! * scale;
}

/**
 * `edge_distance_scale`: raster pixels per display-corrected source pixel, the mask mapping's
 * distance scale.
 */
export function edgeDistanceScale(
  crop: { readonly width: number; readonly height: number } | undefined,
  size: { readonly width: number; readonly height: number },
  width: number,
  height: number,
): number {
  return Math.min(
    width / ((crop?.width ?? 1.0) * size.width),
    height / ((crop?.height ?? 1.0) * size.height),
  );
}

/**
 * `distance_field` on the CPU (float64, byte-exact with the engine): the distance to the nearest
 * `inside` pixel where it is at most `reach`, `Infinity` beyond. `inside` is row-major, 1 = in.
 */
export function edgeDistanceField(
  inside: Uint8Array,
  width: number,
  height: number,
  reach: number,
): Float64Array {
  const beyond = reach + 1;
  const g = new Int32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    let last = -Infinity;
    for (let col = 0; col < width; col += 1) {
      if (inside[row * width + col] === 1) last = col;
      g[row * width + col] = Math.min(col - last, beyond);
    }
    let next = Infinity;
    for (let col = width - 1; col >= 0; col -= 1) {
      if (inside[row * width + col] === 1) next = col;
      const at = row * width + col;
      g[at] = Math.min(g[at]!, next - col, beyond);
    }
  }
  const out = new Float64Array(width * height);
  const limit = reach * reach;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      let best = 2 * beyond * beyond;
      for (let dy = -reach; dy <= reach; dy += 1) {
        const y = row + dy;
        const gy = y < 0 || y >= height ? beyond : g[y * width + col]!;
        best = Math.min(best, gy * gy + dy * dy);
      }
      out[row * width + col] = best <= limit ? Math.sqrt(best) : Infinity;
    }
  }
  return out;
}

/** `shifted`: `inside` moved by `(dx, dy)`; what moves off the raster is gone. */
export function shiftInside(
  inside: Uint8Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const from = row - dy;
    if (from < 0 || from >= height) continue;
    for (let col = 0; col < width; col += 1) {
      const src = col - dx;
      if (src >= 0 && src < width) out[row * width + col] = inside[from * width + src]!;
    }
  }
  return out;
}

/** `style_alpha` for one pixel. */
function styleAlphaAt(style: FramePlanEdgeStyle, distance: number, scale: number): number {
  let alpha: number;
  if (style.kind === 'stroke') {
    alpha = Math.min(Math.max(style.params.widthPx! * scale + 0.5 - distance, 0.0), 1.0);
  } else {
    const t = distance / (edgeSize(style, scale) + 1.0);
    const falling = 1.0 - Math.min(t, 1.0);
    alpha = falling * falling;
  }
  return alpha * style.params.opacity!;
}

/**
 * `apply_edge_styles` on the CPU, float64 in the export's order: the picture (`rgb`, 3 bytes per
 * pixel, and its attached `alpha`) over the styles traced from `stackAlpha`.
 */
export function applyEdgeStylesCpu(
  rgb: Uint8Array,
  alpha: Float64Array,
  stackAlpha: Float64Array,
  width: number,
  height: number,
  styles: readonly FramePlanEdgeStyle[],
  scale: number,
  opacity: number,
): { rgb: Uint8Array; alpha: Float64Array } {
  const count = width * height;
  const inside = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) inside[i] = stackAlpha[i]! >= 0.5 ? 1 : 0;
  const colour = new Float64Array(count * 3);
  const styled = new Float64Array(count);
  const clipOpacity = Math.min(Math.max(opacity, 0.0), 1.0);
  for (const style of styles) {
    const [dx, dy] = edgeShift(style, scale);
    const source = dx === 0 && dy === 0 ? inside : shiftInside(inside, width, height, dx, dy);
    const distance = edgeDistanceField(source, width, height, edgeReach(style, scale));
    const rgbStyle = [
      style.params.red! / 255.0,
      style.params.green! / 255.0,
      style.params.blue! / 255.0,
    ];
    for (let i = 0; i < count; i += 1) {
      const coverage = styleAlphaAt(style, distance[i]!, scale) * clipOpacity;
      const keep = 1.0 - coverage;
      for (let c = 0; c < 3; c += 1) {
        colour[i * 3 + c] = rgbStyle[c]! * coverage + colour[i * 3 + c]! * keep;
      }
      styled[i] = coverage + styled[i]! * keep;
    }
  }
  const outRgb = new Uint8Array(count * 3);
  const outAlpha = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const base = Math.min(Math.max(alpha[i]!, 0.0), 1.0);
    const under = 1.0 - base;
    const a = base + styled[i]! * under;
    outAlpha[i] = a;
    for (let c = 0; c < 3; c += 1) {
      const premultiplied = (rgb[i * 3 + c]! / 255.0) * base + colour[i * 3 + c]! * under;
      const value = a > 0.0 ? premultiplied / a : 0.0;
      outRgb[i * 3 + c] = Math.min(Math.max(roundHalfEven(value * 255.0), 0), 255);
    }
  }
  return { rgb: outRgb, alpha: outAlpha };
}

/**
 * EL2b: a still's cut-out for its edge styles, its own alpha times its alpha stack's coverage
 * when it has one (`_apply_edge_styles` multiplies them), written as the coverage the row pass
 * reads: 255 inside, 0 outside, so the row pass's `>= ½` test is exactly the engine's.
 *
 * @param masked - Whether a stack coverage texture (`u_mask`, R8UI `q / 255 · u_maskScale`) is
 *   bound; without one the cut-out is the picture's alpha alone.
 */
export function edgeOwnAlphaFragment(masked: boolean): string {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D u_picture;
${masked ? 'uniform usampler2D u_mask;\nuniform float u_maskScale;' : ''}
out uvec4 o_value;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float cut = texelFetch(u_picture, p, 0).a;
  ${masked ? 'cut *= float(texelFetch(u_mask, p, 0).r) / 255.0 * u_maskScale;' : ''}
  o_value = uvec4(cut >= 0.5 ? 255u : 0u, 0u, 0u, 255u);
}`;
}

/**
 * Row pass: per pixel, the nearest cut-out column within `u_reach` (or `u_reach + 1`), reading
 * the stack coverage (R8UI, `q / 255 · scale`) at the pixel moved back by the shadow offset.
 */
export const EDGE_ROW_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_mask;
uniform float u_maskScale;
uniform ivec2 u_shift;
uniform int u_reach;
out vec4 o_color;
bool inside(ivec2 q, ivec2 size) {
  if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) return false;
  return float(texelFetch(u_mask, q, 0).r) / 255.0 * u_maskScale >= 0.5;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_mask, 0);
  ivec2 at = p - u_shift;
  int best = u_reach + 1;
  for (int dx = 0; dx <= u_reach; ++dx) {
    if (inside(at + ivec2(dx, 0), size) || inside(at - ivec2(dx, 0), size)) {
      best = dx;
      break;
    }
  }
  o_color = vec4(float(best), 0.0, 0.0, 1.0);
}`;

/** Column pass: `sqrt(min g² + dy²)` within `u_reach`, or −1 for "far". */
export const EDGE_COLUMN_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_row;
uniform int u_reach;
out vec4 o_color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(u_row, 0);
  int beyond = u_reach + 1;
  int best = 2 * beyond * beyond;
  for (int dy = -u_reach; dy <= u_reach; ++dy) {
    int y = p.y + dy;
    if (y < 0 || y >= size.y) continue;
    int g = int(texelFetch(u_row, ivec2(p.x, y), 0).r + 0.5);
    best = min(best, g * g + dy * dy);
  }
  o_color = vec4(best <= u_reach * u_reach ? sqrt(float(best)) : -1.0, 0.0, 0.0, 1.0);
}`;

/**
 * The composite: styles bottom to top in premultiplied colour, then the picture (straight RGBA,
 * as the alpha pass leaves it) over them; straight RGBA out.
 */
export const EDGE_COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_picture;
uniform sampler2D u_distance0;
uniform sampler2D u_distance1;
uniform sampler2D u_distance2;
uniform int u_count;
uniform ivec3 u_kind;
uniform vec3 u_size;
uniform vec3 u_opacity;
uniform vec3 u_colour0;
uniform vec3 u_colour1;
uniform vec3 u_colour2;
uniform float u_clipOpacity;
out vec4 o_color;
float styleAlpha(int kind, float size, float d) {
  if (d < 0.0) return 0.0;
  if (kind == 2) return clamp(size + 0.5 - d, 0.0, 1.0);
  float falling = 1.0 - min(d / (size + 1.0), 1.0);
  return falling * falling;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 styled = vec3(0.0);
  float styledAlpha = 0.0;
  for (int i = 0; i < 3; ++i) {
    if (i >= u_count) break;
    float d = i == 0 ? texelFetch(u_distance0, p, 0).r
      : i == 1 ? texelFetch(u_distance1, p, 0).r : texelFetch(u_distance2, p, 0).r;
    vec3 colour = i == 0 ? u_colour0 : i == 1 ? u_colour1 : u_colour2;
    float coverage = styleAlpha(u_kind[i], u_size[i], d) * u_opacity[i] * u_clipOpacity;
    styled = colour * coverage + styled * (1.0 - coverage);
    styledAlpha = coverage + styledAlpha * (1.0 - coverage);
  }
  vec4 picture = texelFetch(u_picture, p, 0);
  float base = picture.a;
  float outAlpha = base + styledAlpha * (1.0 - base);
  vec3 premultiplied = picture.rgb * base + styled * (1.0 - base);
  vec3 rgb = outAlpha > 0.0 ? premultiplied / outAlpha : vec3(0.0);
  o_color = vec4(clamp(rgb, 0.0, 1.0), outAlpha);
}`;
