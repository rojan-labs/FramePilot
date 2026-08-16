/**
 * The 29 transition passes.
 *
 * Each entry is the body of a `vec4 transition(vec2 uv, float p)` function; the
 * chain concatenates `TRANSITION_FRAGMENT_PREAMBLE + body +
 * TRANSITION_FRAGMENT_EPILOGUE` and compiles it. Params arrive as `uParams[i]`,
 * indexed in `TRANSITION_PARAMS`' declared order for that kind — the chain uploads
 * them in that order, so the indices here and the descriptors there must agree. A
 * parity test asserts the mapping for every kind.
 *
 * Each pass is the GPU twin of the numpy pass with the same name in
 * `engine/python/framepilot_engine/render/transition_passes/`. **Change them
 * together** — that pairing is the entire reason a preview and an export show the
 * same picture, and nothing enforces it but the parity test and this note.
 *
 * Read `glsl-transition-common.ts` first: it defines what a pass returns, why
 * `uIntensity` is each pass's own business, and the `reveal()` primitive that six
 * of the wipes are nothing but a different projection into.
 */
import type { TransitionRenderKind } from '@framepilot/timeline-schema/transition-params';

/** Fragment-shader bodies by render kind. Exhaustive over the enum. */
export const GLSL_TRANSITIONS: Readonly<Record<TransitionRenderKind, string>> = {
  // ---------------------------------------------------------------------
  // Dissolves — alpha only
  // ---------------------------------------------------------------------

  /**
   * `hold` widens a plateau at the halfway blend. A dissolve that lingers there
   * reads as deliberate; the same length without the plateau reads as slow.
   */
  dissolve: `
vec4 transition(vec2 uv, float p) {
  float h = clamp(uParams[0], 0.0, 0.9) * 0.5;
  float ramp = 0.5 - h;
  float a = p < 0.5 - h
    ? p / max(1e-3, ramp) * 0.5
    : (p > 0.5 + h ? 0.5 + (p - 0.5 - h) / max(1e-3, ramp) * 0.5 : 0.5);
  // Mirrors opacity_at: intensity sets how far down the dip goes, so 0.5 is a
  // dissolve that never fully loses the picture rather than a shorter one.
  float floorA = 1.0 - uIntensity;
  return vec4(tex(uv), floorA + (1.0 - floorA) * a);
}`,

  /**
   * Dip and flash are one pass because they differ only in how the colour meets
   * the picture: a dip replaces it, a flash adds to it. Splitting them would mean
   * two shaders whose colour envelope had to be kept identical by hand.
   */
  'dip-color': `
vec4 transition(vec2 uv, float p) {
  float hold = clamp(uParams[3], 0.0, 0.95);
  float k = p <= hold ? 1.0 : 1.0 - (p - hold) / max(1e-3, 1.0 - hold);
  k = clamp(k, 0.0, 1.0) * uIntensity;
  vec3 c = tex(uv);
  vec3 col = vec3(uParams[0], uParams[1], uParams[2]);
  vec3 out3 = uParams[4] < 0.5 ? mix(c, col, k) : screenBlend(c, col * k);
  return vec4(out3, 1.0);
}`,

  /** The next shot arrives brightest-first (or darkest-first), like a film wipe. */
  'luma-fade': `
vec4 transition(vec2 uv, float p) {
  vec3 c = tex(uv);
  float l = luma(c);
  if (uParams[0] > 0.5) l = 1.0 - l;
  return vec4(c, reveal(1.0 - l, p));
}`,

  /** Organic patches arrive first — ink through paper rather than a grid. */
  'noise-dissolve': `
vec4 transition(vec2 uv, float p) {
  float cellPx = max(2.0, uParams[0] * min(uResolution.x, uResolution.y));
  float n = valueNoise01(uv * uResolution, cellPx, int(uParams[1]));
  return vec4(tex(uv), reveal(n, p));
}`,

  /** Blocks arrive in a fixed random order — the arrangement must not re-roll. */
  'pixel-dissolve': `
vec4 transition(vec2 uv, float p) {
  float b = max(2.0, uParams[0]);
  ivec2 cell = ivec2(floor(uv * uResolution / b));
  float n = noiseStable(cell, int(uParams[1]));
  // A hard step per block: a feather here would soften each block's own edges and
  // turn the effect back into the dissolve it is meant to be an alternative to.
  return vec4(tex(uv), step(n, p));
}`,

  /** Coarse blocks resolve into detail. Alpha eases in over the first quarter. */
  mosaic: `
vec4 transition(vec2 uv, float p) {
  float b = max(1.0, uParams[0] * rem());
  vec2 q = (floor(uv * uResolution / b) + 0.5) * b / uResolution;
  return vec4(tex(q), clamp(p * 4.0, 0.0, 1.0));
}`,

  // ---------------------------------------------------------------------
  // Wipes — one reveal primitive, six projections
  // ---------------------------------------------------------------------

  /**
   * `angle` tilts the edge off the travel direction, which is what makes a
   * diagonal wipe the same kind as a horizontal one.
   */
  'wipe-linear': `
vec4 transition(vec2 uv, float p) {
  vec2 d = rotate2(dirUv(), radians(uParams[0]));
  if (dot(d, d) < 1e-6) d = vec2(1.0, 0.0);
  // Normalise the projection so 0..1 spans the frame however the edge is tilted.
  float half = 0.5 * (abs(d.x) + abs(d.y));
  float f = (dot(uv - 0.5, d) + half) / max(1e-3, 2.0 * half);
  return vec4(tex(uv), reveal(f, p));
}`,

  /** A circle opening out of a point, or closing in on one. */
  'wipe-radial': `
vec4 transition(vec2 uv, float p) {
  vec2 c = vec2(uParams[0], 1.0 - uParams[1]);
  vec2 d = squareUv(uv - c);
  // Normalise by the distance to the furthest corner, so the reveal always
  // completes exactly at p = 1 wherever the centre is.
  float maxR = 0.0;
  maxR = max(maxR, length(squareUv(vec2(0.0, 0.0) - c)));
  maxR = max(maxR, length(squareUv(vec2(1.0, 0.0) - c)));
  maxR = max(maxR, length(squareUv(vec2(0.0, 1.0) - c)));
  maxR = max(maxR, length(squareUv(vec2(1.0, 1.0) - c)));
  float f = length(d) / max(1e-3, maxR);
  if (uParams[2] > 0.5) f = 1.0 - f;
  return vec4(tex(uv), reveal(f, p));
}`,

  /** A hand sweeping around the frame. */
  'wipe-clock': `
vec4 transition(vec2 uv, float p) {
  vec2 c = vec2(uParams[0], 1.0 - uParams[1]);
  vec2 d = squareUv(uv - c);
  // Measured from 12 o'clock so "start angle 0" means what a clock face means.
  float a = atan(d.x, d.y) - radians(uParams[2]);
  if (uParams[3] > 0.5) a = -a;
  float f = fract(a / TAU + 1.0);
  return vec4(tex(uv), reveal(f, p));
}`,

  /** Opens from the centre line, or closes in from both edges. */
  'wipe-split': `
vec4 transition(vec2 uv, float p) {
  float axisFrac = uParams[0] < 0.5 ? uv.x : uv.y;
  float f = abs(axisFrac - 0.5) * 2.0;
  // 0 opens from the centre outward; 1 closes in from both edges.
  if (uParams[1] >= 0.5) f = 1.0 - f;
  return vec4(tex(uv), reveal(f, p));
}`,

  /**
   * Five shapes on one signed-distance projection. Each is normalised so its
   * furthest point is at f = 1, which is what lets them share `reveal`.
   */
  'wipe-shape': `
vec4 transition(vec2 uv, float p) {
  vec2 c = vec2(uParams[1], 1.0 - uParams[2]);
  vec2 d = squareUv(uv - c) * 2.0;
  float shape = uParams[0];
  float f;
  if (shape < 0.5) {
    f = (abs(d.x) + abs(d.y)) * 0.62;                       // diamond
  } else if (shape < 1.5) {
    float a = atan(d.y, d.x);
    float r = length(d);
    f = r / (0.55 + 0.45 * cos(a * 5.0)) * 0.62;            // five-point star
  } else if (shape < 2.5) {
    f = min(abs(d.x), abs(d.y)) * 1.6 + length(d) * 0.25;   // cross
  } else if (shape < 3.5) {
    // Heart: the classic implicit curve, rescaled to land near 1 at the corners.
    float x = d.x, y = -d.y + 0.25;
    float t = x * x + y * y - 0.35;
    f = (t * t * t - x * x * y * y * y) * 3.2 + 0.5;
  } else {
    vec2 q = abs(d);
    f = max(q.x * 0.866 + q.y * 0.5, q.y) * 0.9;            // hexagon
  }
  return vec4(tex(uv), reveal(clamp(f, 0.0, 1.4), p));
}`,

  /** Slats, each revealing along its own short axis, optionally staggered. */
  'wipe-bars': `
vec4 transition(vec2 uv, float p) {
  float n = max(1.0, uParams[0]);
  bool vertical = uParams[1] < 0.5;
  float across = vertical ? uv.x : uv.y;
  float along = vertical ? uv.y : uv.x;
  float idx = floor(across * n);
  float delay = (idx / max(1.0, n)) * clamp(uParams[2], 0.0, 0.95);
  float pp = clamp((p - delay) / max(1e-3, 1.0 - delay), 0.0, 1.0);
  // Alternate slats sweep the other way, so the frame does not read as one wipe
  // with a ragged edge.
  if (mod(idx, 2.0) >= 1.0) along = 1.0 - along;
  return vec4(tex(uv), reveal(along, pp));
}`,

  // ---------------------------------------------------------------------
  // Motion — the picture travels
  // ---------------------------------------------------------------------

  /**
   * The picture starts one frame away OPPOSITE its travel and decays to rest, so
   * `direction: left` starts off-screen right. `slices` splits it into bands that
   * arrive from alternating sides; `stagger` delays each behind the last.
   */
  slide: `
vec4 transition(vec2 uv, float p) {
  vec2 d = dirUv();
  if (dot(d, d) < 1e-6) d = vec2(-1.0, 0.0);
  float n = max(1.0, uParams[1]);
  float stagger = clamp(uParams[2], 0.0, 0.95);
  vec2 across = vec2(-d.y, d.x);
  float acrossFrac = abs(across.x) > abs(across.y) ? uv.x : uv.y;
  float idx = floor(clamp(acrossFrac, 0.0, 0.9999) * n);
  float delay = n > 1.0 ? (idx / n) * stagger : 0.0;
  float pp = clamp((p - delay) / max(1e-3, 1.0 - delay), 0.0, 1.0);
  float sgn = (n > 1.0 && mod(idx, 2.0) >= 1.0) ? -1.0 : 1.0;
  float travel = uParams[0] * uIntensity * (1.0 - pp);
  return picture(uv + d * sgn * travel);
}`,

  /**
   * `direction: out` is the reciprocal of `in`, not its negation, so neither can
   * reach a zero scale and intensity 0 is a no-op either way (mirrors zoom_from).
   */
  zoom: `
vec4 transition(vec2 uv, float p) {
  float magnitude = 1.0 + (uParams[0] - 1.0) * uIntensity;
  float from = uDirSign < 0.0 ? 1.0 / max(0.05, magnitude) : magnitude;
  float scale = mix(from, 1.0, p);
  vec2 c = vec2(uParams[1], 1.0 - uParams[2]);
  vec2 q = rotate2(squareUv(uv - c), -uParams[3] * TAU * rem());
  return picture(unsquareUv(q / max(0.05, scale)) + c);
}`,

  spin: `
vec4 transition(vec2 uv, float p) {
  float scale = mix(1.0 + (uParams[1] - 1.0) * uIntensity, 1.0, p);
  vec2 q = rotate2(squareUv(uv - 0.5), -uParams[0] * TAU * rem());
  return picture(unsquareUv(q / max(0.05, scale)) + 0.5);
}`,

  /** Anisotropic: the frame arrives as a smear along one axis and snaps to size. */
  stretch: `
vec4 transition(vec2 uv, float p) {
  float k = mix(1.0 + (uParams[1] - 1.0) * uIntensity, 1.0, p);
  vec2 q = uv - 0.5;
  if (uParams[0] < 0.5) q.x /= max(0.05, k); else q.y /= max(0.05, k);
  return picture(q + 0.5);
}`,

  /**
   * Deterministic from `p` rather than from the wall clock: the same frame of the
   * same transition must shake the same way in the preview and in the export, and
   * a clock-driven jitter cannot promise that.
   */
  shake: `
vec4 transition(vec2 uv, float p) {
  int seed = int(uParams[3]);
  float step = floor(p * max(1.0, uParams[1]));
  float amt = uParams[0] * uIntensity * rem();
  float dx = noiseStable(ivec2(int(step), 0), seed) * 2.0 - 1.0;
  float dy = noiseStable(ivec2(int(step), 1), seed) * 2.0 - 1.0;
  float roll = (noiseStable(ivec2(int(step), 2), seed) * 2.0 - 1.0) * uParams[2];
  vec2 q = rotate2(squareUv(uv - 0.5), -roll * 0.25 * amt);
  return picture(unsquareUv(q) + 0.5 - vec2(dx, dy) * amt * 0.12);
}`,

  // ---------------------------------------------------------------------
  // Optical — the lens misbehaves
  // ---------------------------------------------------------------------

  /** Alpha stays 1: this is the legacy `blur` kind, which never faded. */
  'blur-dissolve': `
vec4 transition(vec2 uv, float p) {
  float radius = uParams[0] * min(uResolution.x, uResolution.y) * rem();
  return vec4(blurBox(uv, radius), 1.0);
}`,

  /** A smear along the travel direction, optionally moving along it as well. */
  'blur-directional': `
vec4 transition(vec2 uv, float p) {
  vec2 d = dirUv();
  if (dot(d, d) < 1e-6) d = vec2(-1.0, 0.0);
  float radius = uParams[0] * min(uResolution.x, uResolution.y) * rem();
  vec2 q = uv + d * uParams[1] * uIntensity * (1.0 - p);
  float inside = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
  if (radius <= 0.5) return vec4(tex(q), inside);
  vec3 total = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float o = (float(i) / 8.0 - 0.5) * 2.0 * radius;
    total += texPx(q, d * o);
  }
  return vec4(total / 9.0, inside);
}`,

  /** Zoom blur and spin blur: the same nine taps along a different path. */
  'blur-radial': `
vec4 transition(vec2 uv, float p) {
  float strength = uParams[0] * rem();
  vec2 c = vec2(uParams[1], 1.0 - uParams[2]);
  if (strength <= 0.001) return vec4(tex(uv), 1.0);
  vec3 total = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float k = float(i) / 8.0;
    vec2 q;
    if (uParams[3] < 0.5) {
      // Zoom: sample along the ray to the centre. 'out' streaks the other way.
      float s = 1.0 - k * strength * 0.35 * (uDirSign < 0.0 ? -1.0 : 1.0);
      q = c + (uv - c) * s;
    } else {
      q = c + unsquareUv(rotate2(squareUv(uv - c), k * strength * 0.5));
    }
    total += tex(q);
  }
  return vec4(total / 9.0, 1.0);
}`,

  /**
   * Rows tear sideways and some are missing entirely, so the shot assembles out of
   * the damage rather than simply appearing behind it.
   */
  glitch: `
vec4 transition(vec2 uv, float p) {
  int seed = int(uParams[3]);
  float blocks = max(2.0, uParams[0]);
  float row = floor(uv.y * blocks);
  float phase = floor(p * 24.0);
  float n = noiseStable(ivec2(int(row), int(phase)), seed);
  float shift = (n * 2.0 - 1.0) * uParams[1] * uIntensity * rem() * 0.4;
  vec2 q = uv + vec2(shift, 0.0);
  float split = uParams[2] * rem() * 0.04;
  vec3 c = vec3(tex(q + vec2(split, 0.0)).r, tex(q).g, tex(q - vec2(split, 0.0)).b);
  float order = noiseStable(ivec2(int(row), 91), seed);
  return vec4(c, step(order, p * 1.25));
}`,

  /** Channels fly apart and converge; the frame dissolves in behind them. */
  'rgb-split': `
vec4 transition(vec2 uv, float p) {
  float amt = uParams[0] * uIntensity * rem() * 0.12;
  vec2 d = vec2(cos(radians(uParams[1])), sin(radians(uParams[1])));
  vec3 c = vec3(tex(uv + d * amt).r, tex(uv).g, tex(uv - d * amt).b);
  return vec4(c, clamp(p * 1.6, 0.0, 1.0));
}`,

  /**
   * A band of light travelling across the frame. In `leak` mode it screens in and
   * carries the incoming shot with it; in `burn` mode the band is where the old
   * frame has been eaten away, so the light and the reveal are the same edge.
   */
  'light-leak': `
vec4 transition(vec2 uv, float p) {
  vec2 d = rotate2(dirUv(), radians(uParams[2]));
  if (dot(d, d) < 1e-6) d = vec2(1.0, 0.0);
  float half = 0.5 * (abs(d.x) + abs(d.y));
  float f = (dot(uv - 0.5, d) + half) / max(1e-3, 2.0 * half);
  float head = p * 1.7 - 0.35;
  // The band fades out as well as travelling: a leak whose glow is still on the
  // frame at progress 1 leaves the shot permanently brighter than it should be.
  float band = exp(-pow((f - head) * 3.2, 2.0)) * (1.0 - p);
  vec3 warm = mix(vec3(1.0, 0.88, 0.66), vec3(1.0, 0.42, 0.12), clamp(uParams[0], 0.0, 1.0));
  vec3 c = tex(uv);
  float glow = band * uParams[1] * uIntensity;
  if (uParams[3] > 0.5) {
    float edge = reveal(f, p);
    return vec4(screenBlend(c, warm * glow * 1.4), edge);
  }
  return vec4(screenBlend(c, warm * glow), clamp(mix(p * 1.2, 1.0, band), 0.0, 1.0));
}`,

  // ---------------------------------------------------------------------
  // Deformation — the picture bends
  // ---------------------------------------------------------------------

  ripple: `
vec4 transition(vec2 uv, float p) {
  vec2 c = vec2(uParams[2], 1.0 - uParams[3]);
  vec2 d = squareUv(uv - c);
  float r = length(d);
  float amp = uParams[0] * uIntensity * rem() * 0.25;
  float wave = sin(r * uParams[1] * TAU - p * TAU * 2.0) * amp * exp(-r * 2.2);
  vec2 dir = r > 1e-4 ? d / r : vec2(0.0);
  return vec4(tex(uv + unsquareUv(dir * wave)), clamp(p * 1.5, 0.0, 1.0));
}`,

  warp: `
vec4 transition(vec2 uv, float p) {
  int seed = int(uParams[2]);
  float cellPx = max(0.02, uParams[1]) * min(uResolution.x, uResolution.y);
  float amp = uParams[0] * uIntensity * rem() * 0.35;
  float nx = valueNoise01(uv * uResolution, cellPx, seed) - 0.5;
  float ny = valueNoise01(uv * uResolution + 137.0, cellPx, seed + 7) - 0.5;
  return vec4(tex(uv + vec2(nx, ny) * amp), clamp(p * 1.4, 0.0, 1.0));
}`,

  /** A vortex that unwinds. Strongest at the centre, so the edges stay readable. */
  liquid: `
vec4 transition(vec2 uv, float p) {
  vec2 c = vec2(uParams[1], 1.0 - uParams[2]);
  vec2 d = squareUv(uv - c);
  float r = length(d);
  float angle = uParams[0] * uIntensity * rem() * 7.0 * exp(-r * 2.5);
  return vec4(tex(c + unsquareUv(rotate2(d, angle))), clamp(p * 1.4, 0.0, 1.0));
}`,

  /** Mirrored wedges that fold back into one frame. */
  kaleidoscope: `
vec4 transition(vec2 uv, float p) {
  float segments = max(2.0, uParams[0]);
  vec2 d = squareUv(uv - 0.5);
  float r = length(d);
  float a = atan(d.y, d.x);
  float wedge = TAU / segments;
  float folded = abs(mod(a, wedge) - wedge * 0.5);
  float a2 = mix(a, folded, rem());
  return vec4(tex(0.5 + unsquareUv(vec2(cos(a2), sin(a2)) * r)), clamp(p * 1.3, 0.0, 1.0));
}`,

  // ---------------------------------------------------------------------
  // Spatial — the picture is a surface in 3D
  // ---------------------------------------------------------------------

  /**
   * One projection, seven looks.
   *
   * A flip is one panel turning about its centre; a door is two turning about
   * their outer edges; a fold is many; a cube pivots on an edge with depth; a
   * carousel adds an arc; a tunnel is pure recession with no turn at all. They are
   * genuinely different pictures and they are the same maths with different
   * numbers, which is exactly the reuse the catalog is built on.
   *
   * Back faces are dropped rather than mirrored: this pass only ever has the
   * INCOMING picture, so a "back face" here would be the same shot reversed, which
   * is worse than the outgoing shot showing through underneath.
   */
  'perspective-3d': `
vec4 transition(vec2 uv, float p) {
  bool vertical = uParams[0] < 0.5;
  float panels = max(1.0, uParams[1]);
  float pivot = clamp(uParams[2], 0.0, 1.0);
  float depth = uParams[3];
  float turns = uParams[4];
  float arc = uParams[5];
  float shade = uParams[6];
  float push = uParams[7];

  float along = vertical ? uv.x : uv.y;
  float other = vertical ? uv.y : uv.x;
  float idx = floor(clamp(along, 0.0, 0.9999) * panels);
  float local = along * panels - idx;
  float sgn = mod(idx, 2.0) < 0.5 ? 1.0 : -1.0;
  float pv = mix(0.5, 0.0, pivot);

  float angle = turns * TAU * rem() * sgn;
  float ca = cos(angle);
  float sa = sin(angle);

  float x = local - pv;
  float z = x * sa + push * rem() * 2.0 + arc * (1.0 - ca);
  // Perspective divide. The clamp keeps a surface that has swung behind the
  // camera from inverting instead of simply disappearing.
  float w = max(0.15, 1.0 + z * depth * 1.1);
  float xp = (x * ca) / w;
  float op = (other - 0.5) / w + 0.5;
  float ap = (xp + pv + idx) / panels;

  vec2 q = vertical ? vec2(ap, op) : vec2(op, ap);
  vec4 c = picture(q);
  // Keep each panel inside its own slot, or a wide panel bleeds over its neighbour.
  float lo = idx / panels;
  float hi = (idx + 1.0) / panels;
  c.a *= step(lo - 1e-4, ap) * step(ap, hi + 1e-4);
  c.a *= step(0.0, ca);
  c.rgb *= mix(1.0, clamp(ca, 0.0, 1.0), shade);
  return c;
}`,

  /**
   * A curl sweeping across, with the shadow the lifted page casts and a lens bend
   * just behind the edge.
   *
   * Honest about its limits: a real page turn shows the BACK of the outgoing page,
   * and this pass only has the incoming picture. What it draws is the reveal edge
   * and its shading, which is the part that reads as a page at speed.
   */
  'page-turn': `
vec4 transition(vec2 uv, float p) {
  vec2 d = rotate2(dirUv(), radians(uParams[1]));
  if (dot(d, d) < 1e-6) d = vec2(1.0, 0.0);
  float half = 0.5 * (abs(d.x) + abs(d.y));
  float f = (dot(uv - 0.5, d) + half) / max(1e-3, 2.0 * half);
  float radius = max(0.02, uParams[0] * 0.35);
  // The edge overshoots by three feathers rather than one, so the curl's lens bend
  // has fully left the frame by progress 1 and the shot lands undistorted.
  float edge = p * (1.0 + radius * 3.0);
  float behind = (edge - f) / radius;
  if (behind < 0.0) return vec4(tex(uv), 0.0);
  // Bend the sampling just behind the edge so the paper reads as curved.
  float bend = exp(-behind * behind * 2.0) * radius * 0.35;
  vec3 c = tex(uv - d * bend);
  float shadow = 1.0 - uParams[2] * 0.65 * exp(-behind * behind * 3.0);
  return vec4(c * shadow, 1.0);
}`,
};
