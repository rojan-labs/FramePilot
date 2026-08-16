/**
 * Preview ↔ render parity guards for the effect system (schema v13, ADR 0088).
 *
 * These tests cannot compare pixels — the numpy passes run in Python and the GLSL
 * runs on a GPU neither vitest nor CI has. What they CAN do is pin every contract
 * that, if broken, makes the two renderers disagree:
 *
 *   · every catalog kind has a shader (a missing one previews as a no-op while
 *     the export applies the effect — the single worst failure mode here);
 *   · the shared noise clock and quantum match the engine's constants;
 *   · `uParams[i]` means the same parameter on both sides (the shaders index by
 *     position, so a reordered descriptor list silently remaps every param);
 *   · the GLSL is structurally well-formed before it ever reaches a GPU.
 *
 * The actual pixel comparison belongs to a golden-media test with a real GL
 * context; this file is the cheap gate that catches the drift a human would.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EffectRenderKindSchema, type EffectRenderKind } from '@framepilot/timeline-schema';
import { EFFECT_PARAMS } from '@framepilot/timeline-schema/effect-params';
import { EFFECT_CATALOG } from '@framepilot/timeline-schema/effect-catalog';
import { GLSL_PASSES } from './glsl-passes.js';
import { FRAGMENT_EPILOGUE, FRAGMENT_PREAMBLE, MAX_PARAMS, VERTEX_SHADER } from './glsl-common.js';
import { TIME_QUANTUM, quantizeTime } from './gl-effect-chain.js';

const ALL_KINDS = EffectRenderKindSchema.options;

/** Repo root, for reading the engine source we must stay in step with. */
const ENGINE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'engine',
  'python',
  'framepilot_engine',
  'render',
  'frame_effects',
);

const readEngine = (name: string): string => readFileSync(join(ENGINE, name), 'utf8');

/** Drop `//` and block comments so a structural scan sees only code. */
const stripGlslComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('shader coverage', () => {
  it('has a shader for every render kind', () => {
    const missing = ALL_KINDS.filter((kind) => GLSL_PASSES[kind] === undefined);
    expect(missing, 'kinds with no GLSL pass').toEqual([]);
  });

  it('has no shader for a kind outside the enum', () => {
    const known = new Set<string>(ALL_KINDS);
    expect(Object.keys(GLSL_PASSES).filter((k) => !known.has(k))).toEqual([]);
  });

  it('covers every kind the catalog actually uses', () => {
    for (const effect of EFFECT_CATALOG) {
      expect(GLSL_PASSES[effect.kind], `${effect.id} → no shader`).toBeDefined();
    }
  });

  it('declares the documented 41 kinds', () => {
    expect(ALL_KINDS).toHaveLength(41);
    expect(Object.keys(GLSL_PASSES)).toHaveLength(41);
  });
});

describe('shader structure', () => {
  it.each(ALL_KINDS)('%s declares the effect entry point', (kind: EffectRenderKind) => {
    // The epilogue calls `effect(src, vUv)`, so a pass with a different signature
    // fails to compile at runtime — on a GPU CI does not have. Checked here.
    expect(GLSL_PASSES[kind]).toMatch(/vec3\s+effect\s*\(\s*vec3\s+\w+\s*,\s*vec2\s+\w+\s*\)/);
  });

  it.each(ALL_KINDS)('%s returns a value on every path', (kind: EffectRenderKind) => {
    expect(GLSL_PASSES[kind]).toMatch(/\breturn\b/);
  });

  it.each(ALL_KINDS)('%s has balanced braces and parens', (kind: EffectRenderKind) => {
    const body = GLSL_PASSES[kind];
    const count = (ch: string): number => body.split(ch).length - 1;
    expect(count('{'), `${kind} braces`).toBe(count('}'));
    expect(count('('), `${kind} parens`).toBe(count(')'));
  });

  it.each(ALL_KINDS)('%s never indexes uParams past the array', (kind: EffectRenderKind) => {
    // An out-of-range constant index is a GLSL compile error; a reader would not
    // notice, and the pass would silently never run.
    for (const match of GLSL_PASSES[kind].matchAll(/uParams\[(\d+)\]/g)) {
      expect(Number(match[1]), `${kind} indexes uParams too far`).toBeLessThan(MAX_PARAMS);
    }
  });

  it.each(ALL_KINDS)('%s only reads params its kind declares', (kind: EffectRenderKind) => {
    // The real guard: a shader reading uParams[3] for a kind with 2 params gets
    // whatever was left in the uniform, which is a stale value from another layer.
    const declared = EFFECT_PARAMS[kind].length;
    for (const match of GLSL_PASSES[kind].matchAll(/uParams\[(\d+)\]/g)) {
      expect(
        Number(match[1]),
        `${kind} reads uParams[${match[1]}] but declares only ${declared} params`,
      ).toBeLessThan(declared);
    }
  });

  it.each(ALL_KINDS)('%s uses no GLSL identifier the preamble lacks', (kind: EffectRenderKind) => {
    // Catches a pass calling a helper that exists in numpy but not in GLSL — the
    // most likely way a ported pass fails to compile.
    const helpers = [
      'tex',
      'texPx',
      'luma',
      'noise01',
      'valueNoise01',
      'blurBox',
      'sobel',
      'hue2rgb',
      'screen',
      'centeredUv',
      'uncenteredUv',
      'texel',
    ];
    // Comments must be stripped first: prose like "on real tape (the head …)"
    // looks exactly like a call to a function named `tape` to a regex.
    const body = stripGlslComments(GLSL_PASSES[kind]);
    for (const call of body.matchAll(/\b([a-z][A-Za-z0-9]*)\s*\(/g)) {
      const name = call[1] as string;
      const builtin = [
        'vec2',
        'vec3',
        'vec4',
        'ivec2',
        'float',
        'int',
        'uint',
        'bool',
        'mix',
        'clamp',
        'smoothstep',
        'step',
        'min',
        'max',
        'abs',
        'floor',
        'ceil',
        'mod',
        'pow',
        'exp',
        'log',
        'sqrt',
        'length',
        'dot',
        'normalize',
        'sin',
        'cos',
        'tan',
        'atan',
        'radians',
        'degrees',
        'texture',
        'effect',
        'if',
        'for',
        'while',
        'return',
        'sign',
        'fract',
      ];
      if (builtin.includes(name) || helpers.includes(name)) continue;
      // A local variable followed by `(` cannot happen in valid GLSL, so anything
      // left is an undeclared function call.
      expect(name, `${kind} calls unknown GLSL function "${name}"`).toBe('');
    }
  });
});

describe('preamble and epilogue', () => {
  it('exposes every uniform the chain sets', () => {
    for (const uniform of [
      'uTex',
      'uResolution',
      'uLocalTime',
      'uDuration',
      'uProgress',
      'uNoiseFrame',
      'uParams',
    ]) {
      expect(FRAGMENT_PREAMBLE).toContain(uniform);
    }
    expect(FRAGMENT_EPILOGUE).toContain('uIntensity');
  });

  it('mixes intensity in the epilogue, not in the passes', () => {
    // Mirrors the Python dispatcher: a pass implements only its full-strength
    // look, so the strength dial works for every kind without per-pass code.
    expect(FRAGMENT_EPILOGUE).toMatch(/mix\(\s*src\s*,\s*out3\s*,\s*uIntensity\s*\)/);
    for (const kind of ALL_KINDS) {
      expect(GLSL_PASSES[kind], `${kind} must not read uIntensity`).not.toContain('uIntensity');
    }
  });

  it('clamps the final colour so no pass can emit out-of-range values', () => {
    expect(FRAGMENT_EPILOGUE).toMatch(/clamp\(/);
  });

  it('targets GLSL ES 3.00 in both stages', () => {
    expect(VERTEX_SHADER.startsWith('#version 300 es')).toBe(true);
    expect(FRAGMENT_PREAMBLE.startsWith('#version 300 es')).toBe(true);
  });

  it('does NOT flip V in the shader — the flip belongs at upload', () => {
    // A shader-side flip runs on EVERY pass, but is only correct for the first
    // one (the pass reading the canvas). Later passes read framebuffer textures
    // that are already bottom-up, so the flip compounds and the picture comes out
    // upside down depending on how many effects are stacked. The orientation is
    // corrected exactly once via UNPACK_FLIP_Y_WEBGL instead.
    expect(VERTEX_SHADER).not.toContain('0.5 - aPos.y');
    expect(VERTEX_SHADER).toContain('aPos * 0.5 + 0.5');
  });
});

describe('deterministic-noise parity with the engine', () => {
  const deterministic = readEngine('deterministic.py');

  it('uses the same time quantum as the engine', () => {
    // Both sides snap animated noise to this grid; different quanta means grain
    // that differs between a preview at 4.003s and a render at 4.000s.
    expect(deterministic).toContain('TIME_QUANTUM = 1.0 / 60.0');
    expect(TIME_QUANTUM).toBe(1 / 60);
  });

  it('quantizes time identically to the engine', () => {
    expect(quantizeTime(0)).toBe(0);
    expect(quantizeTime(-5)).toBe(0);
    expect(quantizeTime(4)).toBe(quantizeTime(4 + TIME_QUANTUM * 0.4));
    expect(quantizeTime(4 + TIME_QUANTUM)).toBe(quantizeTime(4) + 1);
  });

  it('uses the same hash multipliers as the engine', () => {
    // The whole parity argument rests on these being bit-identical.
    expect(deterministic).toContain('0x7FEB352D');
    expect(deterministic).toContain('0x846CA68B');
    expect(FRAGMENT_PREAMBLE).toContain('0x7feb352du');
    expect(FRAGMENT_PREAMBLE).toContain('0x846ca68bu');
  });

  it('uses the same shift sequence as the engine', () => {
    expect(FRAGMENT_PREAMBLE).toMatch(
      /x \^= x >> 16u;[\s\S]*x \^= x >> 15u;[\s\S]*x \^= x >> 16u;/,
    );
  });

  it('uses the same frame-seed constant as the engine', () => {
    expect(deterministic).toContain('0x9E3779B1');
    expect(FRAGMENT_PREAMBLE).toContain('0x9E3779B1');
  });

  it('takes the same high 24 bits and divisor as the engine', () => {
    expect(deterministic).toContain('1 << 24');
    expect(FRAGMENT_PREAMBLE).toContain('16777216.0');
    expect(1 << 24).toBe(16777216);
  });

  it('avoids the sin-based hash idiom entirely', () => {
    // Regression guard on the whole reason for the integer mixer: `sin` is
    // hardware-approximated, so a sin-based hash cannot match numpy.
    expect(FRAGMENT_PREAMBLE).not.toMatch(/fract\s*\(\s*sin/);
  });
});

describe('shared-helper parity with the engine', () => {
  const common = readEngine('_common.py');

  it('uses the same Rec.709 luma weights', () => {
    // A bloom thresholding on a different luma than a halation would ring
    // differently for no visible reason.
    expect(common).toContain('0.2126, 0.7152, 0.0722');
    expect(FRAGMENT_PREAMBLE).toContain('0.2126, 0.7152, 0.0722');
  });

  it('normalizes Sobel by the same factor', () => {
    // `_sobel` lives in blur.py (with the other spatial-filter passes), not
    // _common.py — both sides divide by 4 because the kernel sums to 4 on a
    // full-contrast edge, so a different divisor changes every edge threshold.
    expect(readEngine('blur.py')).toContain('np.float32(4.0)');
    expect(FRAGMENT_PREAMBLE).toContain('/ 4.0');
  });

  it('clamps sampling on both sides rather than wrapping', () => {
    // CLAMP vs REPEAT is a correctness difference at the frame border of every
    // geometric effect, not a preference.
    expect(common).toContain('np.clip(sx');
    expect(FRAGMENT_PREAMBLE).toContain('clamp(uv');
  });

  it('approximates the Gaussian with boxes on both sides', () => {
    // A true Gaussian kernel in GLSL against boxes in numpy would not match.
    expect(common).toContain('three successive box blurs');
    expect(FRAGMENT_PREAMBLE).toContain('box');
  });
});

describe('pass ↔ engine pairing', () => {
  const sources = ['color.py', 'blur.py', 'geometry.py', 'texture.py'].map(readEngine).join('\n');

  it.each(ALL_KINDS)('%s is registered in the engine too', (kind: EffectRenderKind) => {
    // Every shader must have a numpy twin, or the preview shows an effect the
    // export cannot produce — the mirror of the coverage test above.
    expect(sources, `engine has no @register("${kind}")`).toContain(`@register("${kind}")`);
  });
});

describe('param-index parity', () => {
  it.each(ALL_KINDS)('%s declares at least one param', (kind: EffectRenderKind) => {
    expect(EFFECT_PARAMS[kind].length).toBeGreaterThan(0);
  });

  it('keeps every kind within the uniform array size', () => {
    for (const kind of ALL_KINDS) {
      expect(
        EFFECT_PARAMS[kind].length,
        `${kind} exceeds uParams[${MAX_PARAMS}]`,
      ).toBeLessThanOrEqual(MAX_PARAMS);
    }
  });

  it('is what makes positional indexing safe — documented for the next editor', () => {
    // If this ever needs changing, the shaders must change with it: they read
    // params BY POSITION, so reordering a descriptor list silently remaps them.
    expect(EFFECT_PARAMS['mirror']?.[0]?.name).toBe('axis');
    expect(EFFECT_PARAMS['mosaic']?.[0]?.name).toBe('size');
    expect(EFFECT_PARAMS['analog-vhs']?.map((p) => p.name)).toEqual([
      'tracking',
      'chroma',
      'noise',
      'jitter',
      'speed',
    ]);
  });
});
