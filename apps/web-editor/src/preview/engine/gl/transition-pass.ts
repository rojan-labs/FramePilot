/**
 * Catalog transition passes inside the layer compositor (PX2.2).
 *
 * The 29 GLSL passes (`transitions/glsl-transitions.ts`) are the GPU twins of the export's
 * numpy passes and are pinned to them by `transitions/parity.test.ts`. They are written for a
 * y-up picture uploaded with `UNPACK_FLIP_Y`; the compositor keeps textures top-row-first, so the
 * entry point and the sampler are flipped once here rather than re-deriving 29 passes.
 *
 * What the export does with a pass result (`_apply_catalog_transition`): the incoming half
 * replaces the picture and multiplies the clip's mask by the reveal; the outgoing half keeps the
 * picture and multiplies the mask by its complement. Colour is rounded to 8 bits; the mask is
 * truncated when it is composited.
 */
import { TRANSITION_FRAGMENT_PREAMBLE } from '../../transitions/glsl-transition-common.js';
import { GLSL_TRANSITIONS } from '../../transitions/glsl-transitions.js';
import type { TransitionRenderKind } from '@framepilot/timeline-schema/transition-params';

/** The layer compositor's texel convention: row 0 is the top of the picture. */
const FLIPPED_SAMPLER = `vec3 tex(vec2 uv) { vec2 c = clamp(uv, texel() * 0.5, 1.0 - texel() * 0.5); return texture(uTex, vec2(c.x, 1.0 - c.y)).rgb; }`;

const EPILOGUE = `
uniform int uRole;
uniform sampler2D uAlphaSource;
void main() {
  vec2 frag = gl_FragCoord.xy / uResolution;
  vec2 uv = vec2(frag.x, 1.0 - frag.y);
  vec4 result = transition(uv, uProgress);
  vec4 current = texelFetch(uAlphaSource, ivec2(gl_FragCoord.xy), 0);
  float revealed = clamp(result.a, 0.0, 1.0);
  if (uRole == 0) {
    fragColor = vec4(floor(clamp(result.rgb, 0.0, 1.0) * 255.0 + 0.5) / 255.0,
                     floor(current.a * revealed * 255.0 + 1e-3) / 255.0);
  } else {
    fragColor = vec4(current.rgb, floor(current.a * (1.0 - revealed) * 255.0 + 1e-3) / 255.0);
  }
}`;

/** The fragment source of one catalog pass for the compositor, or `null` for an unknown kind. */
export function transitionPassSource(kind: TransitionRenderKind): string | null {
  const body = GLSL_TRANSITIONS[kind];
  if (body === undefined) return null;
  const preamble = TRANSITION_FRAGMENT_PREAMBLE.replace(
    /vec3 tex\(vec2 uv\) \{[^\n]*\}/,
    FLIPPED_SAMPLER,
  ).replace('in vec2 vUv;\n', '');
  return `${preamble}\n${body}\n${EPILOGUE}`;
}
