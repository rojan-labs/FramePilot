/**
 * The 41 fragment-shader passes (schema v13, ADR 0088).
 *
 * Each entry is the body of a `vec3 effect(vec3 c, vec2 uv)` function; the chain
 * concatenates `FRAGMENT_PREAMBLE + body + FRAGMENT_EPILOGUE` and compiles it.
 * Params arrive as 'uParams[i]', indexed in the CATALOG's declared order for that
 * kind — the chain uploads them in that order, so the indices here and
 * 'EFFECT_PARAMS' in `@framepilot/timeline-schema/effect-params` must agree. A
 * parity test asserts the mapping for every kind.
 *
 * Each pass is the GPU twin of the numpy pass with the same name in
 * `engine/python/framepilot_engine/render/frame_effects/`. **Change them
 * together** — that pairing is the entire reason a preview and an export show the
 * same picture, and nothing else enforces it but the parity tests and this note.
 *
 * 'intensity' is NOT handled here: the epilogue mixes it, exactly as the Python
 * dispatcher does, so each pass only implements its full-strength look.
 */
import type { EffectRenderKind } from '@framepilot/timeline-schema';

/** Fragment-shader bodies by render kind. Exhaustive over the enum. */
export const GLSL_PASSES: Readonly<Record<EffectRenderKind, string>> = {
  // ---------------------------------------------------------------------
  // Blur & focus
  // ---------------------------------------------------------------------
  'blur-gaussian': `
vec3 effect(vec3 c, vec2 uv) {
  return blurBox(uv, uParams[0]);
}`,

  'blur-directional': `
vec3 effect(vec3 c, vec2 uv) {
  float radius = uParams[0];
  if (radius <= 0.5) return c;
  float a = radians(uParams[1]);
  vec2 dir = vec2(cos(a), sin(a));
  vec3 total = vec3(0.0);
  // 9 taps, matching the numpy pass's fixed tap count exactly.
  for (int i = 0; i < 9; i++) {
    float o = (float(i) / 8.0 - 0.5) * 2.0 * radius;
    total += texPx(uv, dir * o);
  }
  return total / 9.0;
}`,

  'blur-radial': `
vec3 effect(vec3 c, vec2 uv) {
  float strength = uParams[0];
  if (strength <= 0.0) return c;
  vec2 centre = vec2(uParams[1], uParams[2]);
  vec3 total = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float s = 1.0 - (float(i) / 8.0) * strength * 0.25;
    total += tex(centre + (uv - centre) * s);
  }
  return total / 9.0;
}`,

  'tilt-shift': `
vec3 effect(vec3 c, vec2 uv) {
  vec3 blurred = blurBox(uv, uParams[0]);
  float band = uParams[2];
  float inner = max(0.01, band * 0.5);
  float d = abs(uv.y - uParams[1]);
  float w = smoothstep(inner, inner + 0.12 + band * 0.3, d);
  return mix(c, blurred, w);
}`,

  'soft-focus': `
vec3 effect(vec3 c, vec2 uv) {
  vec3 blurred = blurBox(uv, uParams[0]);
  // Screen, not lerp: highlights spread while the core stays readable. A lerp
  // would just look out of focus.
  vec3 out3 = mix(c, screen(c, blurred), uParams[1]);
  return out3 + (1.0 - out3) * uParams[2];
}`,

  // ---------------------------------------------------------------------
  // Glow & bloom
  // ---------------------------------------------------------------------
  bloom: `
vec3 effect(vec3 c, vec2 uv) {
  float threshold = uParams[0];
  float m = smoothstep(threshold, min(1.0, threshold + 0.2), luma(c));
  vec3 glow = blurBox(uv, uParams[2]) * m;
  return c + glow * uParams[1];
}`,

  'glow-diffuse': `
vec3 effect(vec3 c, vec2 uv) {
  vec3 glow = blurBox(uv, uParams[1]);
  return mix(c, screen(c, glow), uParams[0]);
}`,

  halation: `
vec3 effect(vec3 c, vec2 uv) {
  float threshold = uParams[0];
  float m = smoothstep(threshold, min(1.0, threshold + 0.25), luma(c));
  vec3 bleed = blurBox(uv, 18.0) * m;
  return screen(c, bleed * hue2rgb(uParams[2]) * uParams[1]);
}`,

  // ---------------------------------------------------------------------
  // Light & lens
  // ---------------------------------------------------------------------
  'light-leak': `
vec3 effect(vec3 c, vec2 uv) {
  float a = radians(uParams[0]);
  float warmth = uParams[2];
  float axis = (uv.x - 0.5) * cos(a) + (uv.y - 0.5) * sin(a);
  // Slow organic drift on the band centre, on the quantized clock so it matches
  // the render frame for frame.
  float wobble = valueNoise01(vec2(0.0), 4.0, 0);
  float centre = (uParams[3] - 0.5) + (wobble - 0.5) * 0.06;
  float band = exp(-pow((axis - centre) * 6.0, 2.0));
  vec3 tint = vec3(1.0, 0.72 + 0.2 * warmth, 0.42 + 0.1 * warmth);
  vec3 warm = tint / max(max(tint.r, max(tint.g, tint.b)), 1e-6);
  return screen(c, band * warm * uParams[1]);
}`,

  'lens-flare': `
vec3 effect(vec3 c, vec2 uv) {
  vec2 src = vec2(uParams[0], uParams[1]);
  float strength = uParams[2];
  float spread = uParams[3];
  vec2 d = uv - src;
  // Tight vertically, wide horizontally — the anamorphic streak.
  float streak = exp(-pow(d.y * 60.0, 2.0)) * exp(-pow(d.x / (0.15 + spread * 0.5), 2.0));
  float core = exp(-dot(d, d) * 600.0);
  vec2 g = uv - (1.0 - src);
  float ghost = exp(-dot(g, g) * 300.0) * 0.4;
  vec3 add = ((streak + core) * vec3(0.55, 0.72, 1.0) + vec3(ghost)) * strength;
  return screen(c, add);
}`,

  vignette: `
vec3 effect(vec3 c, vec2 uv) {
  float amount = uParams[0];
  float radius = uParams[1];
  float softness = uParams[2];
  float aspect = uResolution.x / max(1.0, uResolution.y);
  // Aspect-corrected so a 9:16 frame vignettes in a circle, not an ellipse.
  vec2 d = (uv - 0.5) * 2.0 * vec2(max(1.0, aspect), max(1.0, 1.0 / aspect));
  float inner = radius * 1.4;
  float f = smoothstep(inner, inner + 0.05 + softness * 1.2, length(d));
  return c * (1.0 - f * amount);
}`,

  // ---------------------------------------------------------------------
  // Film & cinematic
  // ---------------------------------------------------------------------
  'film-fade': `
vec3 effect(vec3 c, vec2 uv) {
  float lift = uParams[0];
  float rolloff = uParams[1];
  float warmth = uParams[2];
  // Lift/roll FIRST, then grade — the order a film print does it. Grading first
  // would push warm highlights past the shoulder and clip them.
  vec3 out3 = lift + c * (1.0 - lift);
  float knee = 1.0 - rolloff * 0.35;
  out3 = mix(out3, knee + (out3 - knee) * (1.0 - rolloff), step(knee, out3));
  out3 *= vec3(1.0 + warmth * 0.12, 1.0, 1.0 - warmth * 0.12);
  float l = luma(out3);
  return vec3(l) + (out3 - vec3(l)) * uParams[3];
}`,

  'film-curve': `
vec3 effect(vec3 c, vec2 uv) {
  float contrast = uParams[0];
  float strength = uParams[3];
  vec3 shadow = hue2rgb(uParams[1]);
  vec3 highlight = hue2rgb(uParams[2]);
  vec3 curved = mix(c, smoothstep(vec3(0.0), vec3(1.0), c), contrast);
  float l = luma(curved);
  // Weights vanish at mid-grey so skin keeps its own colour — the point of a
  // split tone rather than a wash.
  float sw = clamp(1.0 - l * 2.0, 0.0, 1.0) * strength;
  float hw = clamp(l * 2.0 - 1.0, 0.0, 1.0) * strength;
  vec3 toned = curved * (1.0 - sw) + curved * shadow * sw * 1.6;
  toned = toned * (1.0 - hw) + mix(toned, highlight, 0.5) * hw;
  return toned;
}`,

  // ---------------------------------------------------------------------
  // Chromatic separation
  // ---------------------------------------------------------------------
  'chroma-shift': `
vec3 effect(vec3 c, vec2 uv) {
  float a = radians(uParams[1]);
  // Radial weight is what separates real aberration from a flat channel offset:
  // glass is sharp on axis and disperses at the periphery.
  float radial = length((uv - 0.5) * 2.0);
  vec2 off = vec2(cos(a), sin(a)) * uParams[0] * 0.02 * uResolution.x * radial;
  return vec3(texPx(uv, off).r, c.g, texPx(uv, -off).b);
}`,

  'rgb-split': `
vec3 effect(vec3 c, vec2 uv) {
  float a = radians(uParams[1]);
  vec2 off = vec2(cos(a), sin(a)) * uParams[0] * 0.03 * uResolution.x;
  return vec3(texPx(uv, off).r, c.g, texPx(uv, -off).b);
}`,

  // ---------------------------------------------------------------------
  // Glitch & digital
  // ---------------------------------------------------------------------
  'glitch-block': `
vec3 effect(vec3 c, vec2 uv) {
  float density = uParams[0];
  float displace = uParams[2];
  float blockH = max(2.0, (0.02 + uParams[1] * 0.14) * uResolution.y);
  int row = int(floor(uv.y * uResolution.y / blockH));
  float pick = noise01(ivec2(0, row), 41);
  float active = pick > (1.0 - density * 0.45) ? 1.0 : 0.0;
  float amt = (noise01(ivec2(0, row), 42) - 0.5) * 2.0;
  float offset = active * amt * displace * 0.25 * uResolution.x;
  vec3 torn = texPx(uv, vec2(offset, 0.0));
  // Displaced blocks also lose colour registration, which is what reads as
  // digital corruption rather than a pan.
  float shift = active * displace * 0.01 * uResolution.x;
  float r = texPx(uv, vec2(offset + shift, 0.0)).r;
  return vec3(r, torn.g, torn.b);
}`,

  datamosh: `
vec3 effect(vec3 c, vec2 uv) {
  float strength = uParams[0];
  if (strength <= 0.0) return c;
  float block = max(4.0, (0.02 + uParams[1] * 0.08) * max(uResolution.x, uResolution.y));
  ivec2 b = ivec2(floor(uv * uResolution / block));
  // A per-block pseudo motion vector: the visual signature of a datamosh without
  // needing the previous frame (which would make the render order-dependent).
  vec2 v = vec2(noise01(b, 51), noise01(b, 52)) * 2.0 - 1.0;
  float reach = strength * block;
  vec3 total = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    total += texPx(uv, v * (float(i) / 4.0) * reach);
  }
  return mix(c, total / 5.0, strength);
}`,

  'pixel-sort': `
vec3 effect(vec3 c, vec2 uv) {
  float amount = uParams[1];
  if (amount <= 0.0) return c;
  bool vertical = uParams[2] >= 0.5;
  float span = max(1.0, amount * 0.08 * (vertical ? uResolution.y : uResolution.x));
  vec3 best = c;
  // Running maximum along the axis, gated by brightness — the same bright-streak
  // read as a true sort, which a fragment shader cannot do.
  for (int i = 1; i <= 8; i++) {
    float d = span * float(i) / 8.0;
    vec2 off = vertical ? vec2(0.0, d) : vec2(d, 0.0);
    vec3 s = texPx(uv, -off);
    if (luma(s) > uParams[0]) best = max(best, s);
  }
  return mix(c, best, amount);
}`,

  // ---------------------------------------------------------------------
  // Motion & impact
  // ---------------------------------------------------------------------
  shake: `
vec3 effect(vec3 c, vec2 uv) {
  float amplitude = uParams[0];
  float rotation = uParams[2];
  float t = uLocalTime * uParams[1];
  // Two incommensurate sine pairs: organic, non-repeating, and reproducible on
  // both sides without a RNG.
  float ox = (sin(t * 2.0 * PI) + 0.6 * sin(t * 5.3 * PI)) * amplitude * 0.02;
  float oy = (cos(t * 2.3 * PI) + 0.6 * cos(t * 4.7 * PI)) * amplitude * 0.02;
  float a = sin(t * 3.1 * PI) * rotation * 0.05;
  vec2 d = uv - 0.5;
  float ca = cos(a), sa = sin(a);
  // Slight overscan so the shake never exposes a black edge.
  float overscan = 1.0 / (1.0 + amplitude * 0.06);
  vec2 r = vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca) * overscan;
  return tex(r + 0.5 + vec2(ox, oy));
}`,

  'zoom-punch': `
vec3 effect(vec3 c, vec2 uv) {
  float amount = uParams[0];
  float attack = max(1e-3, uParams[1]);
  float hold = uParams[2];
  float p = uProgress;
  float envelope;
  if (p < attack) {
    envelope = smoothstep(0.0, 1.0, p / attack);
  } else if (p < attack + hold) {
    envelope = 1.0;
  } else {
    float release = max(1e-3, 1.0 - attack - hold);
    envelope = 1.0 - smoothstep(0.0, 1.0, (p - attack - hold) / release);
  }
  float s = 1.0 / (1.0 + amount * envelope);
  return tex(0.5 + (uv - 0.5) * s);
}`,

  'whip-pan': `
vec3 effect(vec3 c, vec2 uv) {
  float a = radians(uParams[1]);
  // Peak mid-layer and ease out both sides, so the throw is a complete gesture
  // whatever the layer's length.
  float envelope = sin(clamp(uProgress, 0.0, 1.0) * PI);
  vec2 shift = vec2(cos(a), sin(a)) * uParams[0] * envelope * 0.5 * uResolution.x;
  vec3 total = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    total += texPx(uv, shift * (float(i) / 6.0) * uParams[2]);
  }
  return total / 7.0;
}`,

  // ---------------------------------------------------------------------
  // Distortion & warp
  // ---------------------------------------------------------------------
  fisheye: `
vec3 effect(vec3 c, vec2 uv) {
  float amount = uParams[0];
  float zoom = max(0.01, uParams[1]);
  vec2 cc = centeredUv(uv);
  float r = length(cc);
  // Floor the denominator rather than branching: dividing by a clamped epsilon
  // is the same guard the numpy pass uses at the exact centre.
  float safe = max(r, 1e-6);
  float theta = atan(r * (1.0 + amount * 2.0));
  float scale = (r > 1e-6 ? theta / (safe * (PI / 2.0)) : 1.0) / zoom;
  return tex(uncenteredUv(cc * scale));
}`,

  'barrel-warp': `
vec3 effect(vec3 c, vec2 uv) {
  vec2 cc = centeredUv(uv);
  // Brown-Conrady radial term: positive k samples further out, magnifying the
  // centre into a barrel bulge.
  float f = 1.0 + uParams[0] * 0.4 * dot(cc, cc);
  return tex(uncenteredUv(cc * f));
}`,

  ripple: `
vec3 effect(vec3 c, vec2 uv) {
  float amplitude = uParams[0];
  float frequency = uParams[1];
  float phase = uLocalTime * uParams[2] * 2.0 * PI;
  float amp = amplitude * 0.03 * uResolution.x;
  // Both axes, quarter-cycle apart, so it reads as water not a shear.
  float dx = sin(uv.y * frequency * 2.0 * PI + phase) * amp;
  float dy = cos(uv.x * frequency * 2.0 * PI + phase) * amp * 0.6;
  return texPx(uv, vec2(dx, dy));
}`,

  // ---------------------------------------------------------------------
  // Pixel & halftone
  // ---------------------------------------------------------------------
  mosaic: `
vec3 effect(vec3 c, vec2 uv) {
  float size = max(2.0, uParams[0]);
  vec2 px = uv * uResolution;
  // Read the cell CENTRE, so a cell is its representative colour rather than
  // whichever pixel landed on the corner.
  vec2 cell = (floor(px / size) + 0.5) * size;
  return blurBox(cell / uResolution, size * 0.5);
}`,

  halftone: `
vec3 effect(vec3 c, vec2 uv) {
  float dot0 = max(2.0, uParams[0]);
  float a = radians(uParams[1]);
  vec2 px = uv * uResolution;
  // Rotate the SCREEN, not the image: that is what stops the pattern beating
  // against horizontal picture detail.
  vec2 r = vec2(px.x * cos(a) - px.y * sin(a), px.x * sin(a) + px.y * cos(a));
  vec2 f = mod(r, dot0) / dot0 - 0.5;
  float d = length(f) * 2.0;
  float l = luma(blurBox(uv, dot0 / 3.0));
  float radius = sqrt(clamp(1.0 - l, 0.0, 1.0));
  float ink = smoothstep(0.0, 0.25, radius - d);
  return mix(c, vec3(1.0 - ink), uParams[2]);
}`,

  dither: `
vec3 effect(vec3 c, vec2 uv) {
  float levels = max(2.0, uParams[0]);
  // Bayer 4x4 as an expression rather than a lookup table: identical values to
  // the numpy matrix, and no uniform array to keep in sync.
  ivec2 p = ivec2(mod(uv * uResolution, 4.0));
  int idx = p.y * 4 + p.x;
  float bayer[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
                              3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  float threshold = bayer[idx] / 16.0 - 0.5;
  float steps = levels - 1.0;
  vec3 nudged = c + threshold * uParams[1] / steps;
  return clamp(floor(clamp(nudged, 0.0, 1.0) * steps + 0.5) / steps, 0.0, 1.0);
}`,

  posterize: `
vec3 effect(vec3 c, vec2 uv) {
  float steps = max(2.0, uParams[0]) - 1.0;
  float l = luma(c);
  vec3 boosted = vec3(l) + (c - vec3(l)) * uParams[1];
  // Round, not floor: flooring would darken the image by half a band.
  return floor(clamp(boosted, 0.0, 1.0) * steps + 0.5) / steps;
}`,

  // ---------------------------------------------------------------------
  // Grain & texture
  // ---------------------------------------------------------------------
  grain: `
vec3 effect(vec3 c, vec2 uv) {
  float size = max(0.5, uParams[1]);
  ivec2 cell = ivec2(floor(uv * uResolution / size));
  float n = noise01(cell, 0) - 0.5;
  // Grain is strongest in the midtones on real stock — it vanishes in blown
  // highlights and is buried in the blacks.
  float w = clamp(1.0 - abs(luma(c) - 0.5) * 1.6, 0.15, 1.0);
  return c + vec3(n * w * uParams[0] * 0.5);
}`,

  'dust-scratches': `
vec3 effect(vec3 c, vec2 uv) {
  float density = uParams[0];
  float scratches = uParams[1];
  vec2 px = uv * uResolution;
  vec3 out3 = c;
  if (density > 0.0) {
    ivec2 cell = ivec2(floor(px / 3.0));
    float spec = noise01(cell, 11);
    float hit = smoothstep(1.0 - density * 0.02, 1.0, spec);
    // Dust reads BOTH ways on a print: opaque specks and clear pinholes.
    float polarity = noise01(cell, 12);
    out3 = polarity > 0.5 ? out3 + vec3(hit) : out3 * (1.0 - hit);
  }
  if (scratches > 0.0) {
    // One value per column, so a scratch is a full-height line.
    float col = noise01(ivec2(int(floor(px.x / 2.0)), 0), 13);
    float line = smoothstep(1.0 - scratches * 0.01, 1.0, col);
    out3 += vec3(line * 0.35);
  }
  return out3;
}`,

  scanlines: `
vec3 effect(vec3 c, vec2 uv) {
  float count = max(1.0, uParams[0]);
  float drift = uLocalTime * uParams[3] * uParams[2] * count * 0.25;
  // A raised cosine, not alternating rows: survives downscaling without moiré.
  float line = 0.5 + 0.5 * cos((uv.y * count + drift) * 2.0 * PI);
  return c * (1.0 - uParams[1] * line);
}`,

  'analog-vhs': `
vec3 effect(vec3 c, vec2 uv) {
  float tracking = uParams[0];
  float chroma = uParams[1];
  float noiseAmount = uParams[2];
  float jitter = uParams[3];
  vec2 px = uv * uResolution;

  // 1. Per-line horizontal jitter — the most recognisable VHS trait.
  float lineNoise = valueNoise01(vec2(0.0, px.y), 3.0, 21) - 0.5;
  float offset = lineNoise * jitter * 0.05 * uResolution.x;

  // 2. Tracking band: a region tearing sideways, drifting up the frame.
  float bandCentre = mod(uLocalTime * 0.35, 1.3) - 0.15;
  float band = exp(-pow((uv.y - bandCentre) * 22.0, 2.0));
  offset += band * tracking * 0.12 * uResolution.x;

  vec3 warped = texPx(uv, vec2(offset, 0.0));

  // 3. Chroma bleed: colour smears because chroma was recorded at a fraction of
  // luma bandwidth.
  vec3 bled = texPx(uv, vec2(offset - chroma * 0.012 * uResolution.x, 0.0));
  vec3 out3 = vec3(mix(warped.r, bled.r, chroma), warped.g, mix(warped.b, bled.b, chroma));

  // 4. Tape noise, worst in the darks where signal-to-noise was worst.
  float n = noise01(ivec2(px), 22) - 0.5;
  float darkWeight = clamp(1.0 - luma(out3), 0.2, 1.0);
  return out3 + vec3(n * darkWeight * noiseAmount * 0.35);
}`,

  'tape-dropout': `
vec3 effect(vec3 c, vec2 uv) {
  float density = uParams[0];
  float length0 = uParams[1];
  int row = int(floor(uv.y * uResolution.y));
  float line = noise01(ivec2(0, row), 31);
  float hit = smoothstep(1.0 - density * 0.15, 1.0, line);
  float start = noise01(ivec2(0, row), 32);
  float span = 0.05 + length0 * 0.5;
  float inside = smoothstep(0.0, 0.02, uv.x - start)
               * (1.0 - smoothstep(span - 0.05, span, uv.x - start));
  float streak = hit * inside;
  // Dropout goes bright on real tape (the head reads full-scale noise).
  return mix(c, vec3(0.85 + luma(c) * 0.15), streak);
}`,

  // ---------------------------------------------------------------------
  // Party & neon
  // ---------------------------------------------------------------------
  'neon-edge': `
vec3 effect(vec3 c, vec2 uv) {
  float threshold = uParams[0];
  float strength = uParams[2];
  float e = smoothstep(threshold, min(1.0, threshold + 0.12), sobel(uv));
  // Widen by sampling the neighbourhood's edge response, approximating the
  // numpy dilation.
  float thick = uParams[3];
  float spread = e;
  for (int i = 1; i <= 3; i++) {
    float d = 1.0 + thick * 3.0 * float(i) / 3.0;
    spread = max(spread, sobel(uv + vec2(d, 0.0) * texel()) * 0.8);
    spread = max(spread, sobel(uv - vec2(d, 0.0) * texel()) * 0.8);
    spread = max(spread, sobel(uv + vec2(0.0, d) * texel()) * 0.8);
    spread = max(spread, sobel(uv - vec2(0.0, d) * texel()) * 0.8);
  }
  // Darken the base so the neon has something to sit against — neon over a
  // bright frame just reads as a colour cast.
  vec3 base = c * (1.0 - strength * 0.55);
  vec3 lit = (e + spread * 0.8) * hue2rgb(uParams[1]) * strength * 1.4;
  return screen(base, lit);
}`,

  'strobe-color': `
vec3 effect(vec3 c, vec2 uv) {
  float frequency = uParams[2];
  if (frequency <= 0.0) return c;
  float phase = mod(uLocalTime * frequency, 2.0);
  // Square alternation with a short crossfade: snaps on the beat without
  // tearing a frame in half at high rates.
  float blend = smoothstep(0.85, 1.15, phase);
  if (phase > 1.5) blend = 1.0 - smoothstep(1.85, 2.0, phase);
  vec3 wash = mix(hue2rgb(uParams[0]), hue2rgb(uParams[1]), blend);
  // Multiply against luma so the wash keeps the picture's tonal structure.
  return mix(c, vec3(luma(c)) * wash, uParams[3]);
}`,

  // ---------------------------------------------------------------------
  // Comic, edge & outline
  // ---------------------------------------------------------------------
  sketch: `
vec3 effect(vec3 c, vec2 uv) {
  float threshold = uParams[1] * 0.5;
  float ink = smoothstep(threshold, min(1.0, threshold + 0.25), sobel(uv));
  return mix(c, vec3(1.0 - ink), uParams[0]);
}`,

  'edge-outline': `
vec3 effect(vec3 c, vec2 uv) {
  float threshold = uParams[0];
  float thick = uParams[1];
  float e = smoothstep(threshold, min(1.0, threshold + 0.15), sobel(uv));
  float spread = e;
  for (int i = 1; i <= 3; i++) {
    float d = 1.0 + thick * 3.0 * float(i) / 3.0;
    spread = max(spread, sobel(uv + vec2(d, 0.0) * texel()) * 0.8);
    spread = max(spread, sobel(uv - vec2(d, 0.0) * texel()) * 0.8);
    spread = max(spread, sobel(uv + vec2(0.0, d) * texel()) * 0.8);
    spread = max(spread, sobel(uv - vec2(0.0, d) * texel()) * 0.8);
  }
  // Screen white along the edges so they read as light, not paint.
  return c + (1.0 - c) * spread * uParams[2];
}`,

  // ---------------------------------------------------------------------
  // Flash & strobe
  // ---------------------------------------------------------------------
  flash: `
vec3 effect(vec3 c, vec2 uv) {
  float frequency = uParams[0];
  float duty = uParams[2];
  if (frequency <= 0.0 || duty <= 0.0) return c;
  float phase = mod(uLocalTime * frequency, 1.0);
  if (phase >= duty) return c;
  // Ramp down across the lit portion: a hard square edge reads as a dropped
  // frame rather than a flash.
  float lit = (1.0 - phase / duty) * uParams[1];
  return c + (1.0 - c) * lit;
}`,

  flicker: `
vec3 effect(vec3 c, vec2 uv) {
  float frequency = uParams[0];
  if (frequency <= 0.0) return c;
  float regular = 0.5 + 0.5 * sin(uLocalTime * frequency * 2.0 * PI);
  float jitter = valueNoise01(vec2(0.0), 2.0, 7);
  float level = mix(regular, jitter, uParams[2]);
  return c * (1.0 - uParams[1] * (1.0 - level));
}`,

  // ---------------------------------------------------------------------
  // Mirror & split
  // ---------------------------------------------------------------------
  mirror: `
vec3 effect(vec3 c, vec2 uv) {
  // 'axis' is a CHOICE param — the value is an index into the descriptor's
  // choices list, which is how the schema keeps params uniformly numeric.
  int axis = int(uParams[0] + 0.5);
  float seam = clamp(uParams[1], 0.0, 1.0);
  vec2 p = uv;
  if (axis == 0) {
    if (uv.x > seam) p.x = seam - (uv.x - seam);
  } else if (axis == 1) {
    if (uv.x < seam) p.x = seam + (seam - uv.x);
  } else if (axis == 2) {
    if (uv.y > seam) p.y = seam - (uv.y - seam);
  } else {
    if (uv.y < seam) p.y = seam + (seam - uv.y);
  }
  return tex(p);
}`,

  kaleidoscope: `
vec3 effect(vec3 c, vec2 uv) {
  float segments = max(2.0, floor(uParams[0] + 0.5));
  float rotation = radians(uParams[1]);
  float zoom = max(0.01, uParams[2]);
  vec2 cc = centeredUv(uv);
  float r = length(cc) / zoom;
  float a = atan(cc.y, cc.x) + rotation;
  float wedge = 2.0 * PI / segments;
  // Fold, then MIRROR the fold: without the mirror the seams are discontinuous
  // and it reads as a stutter rather than a reflection.
  float folded = mod(a, wedge);
  folded = min(folded, wedge - folded);
  return tex(uncenteredUv(vec2(cos(folded), sin(folded)) * r));
}`,
};
