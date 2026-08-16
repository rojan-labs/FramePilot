/**
 * Preview ↔ render parity guards for the transition system.
 *
 * These cannot compare pixels — the numpy passes run in Python and the GLSL needs
 * a GPU neither vitest nor CI has. What they CAN pin is every contract that, if
 * broken, makes the two renderers disagree:
 *
 *   · every render kind has a shader (a missing one previews as a no-op while the
 *     export applies the transition — the worst failure mode here, because the
 *     editor only finds out after a render);
 *   · every render kind has a numpy twin with the same name;
 *   · `uParams[i]` means the same parameter on both sides — the shaders index by
 *     position, so a reordered descriptor list silently remaps every param;
 *   · the GLSL is structurally well-formed before it ever reaches a GPU.
 *
 * The pixel comparison belongs to a golden-media test with a real GL context;
 * this is the cheap gate that catches the drift a human reviewer would not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRANSITION_DIRECTIONS,
  TRANSITION_PARAMS,
  TRANSITION_RENDER_KINDS,
  readsUniversalParam,
  type TransitionRenderKind,
} from '@framepilot/timeline-schema/transition-params';
import { TRANSITION_CATALOG } from '@framepilot/timeline-schema/transition-catalog';
import { GLSL_TRANSITIONS } from './glsl-transitions.js';
import {
  MAX_PARAMS,
  SOFTNESS_MAX,
  TRANSITION_FRAGMENT_EPILOGUE,
  TRANSITION_FRAGMENT_PREAMBLE,
  TRANSITION_VERTEX_SHADER,
} from './glsl-transition-common.js';

/** The engine package this file must stay in step with. */
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
);

/**
 * Every render kind the engine's numpy package registers a pass for.
 *
 * Read out of the source rather than imported, obviously — but the alternative is
 * no cross-language check at all, and "the shader exists but the numpy pass does
 * not" is a bug that only shows up after an export.
 */
const enginePassKinds = (): Set<string> => {
  const dir = join(ENGINE, 'transition_passes');
  const kinds = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.py')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const match of source.matchAll(/@register\("([a-z0-9-]+)"\)/g)) kinds.add(match[1]!);
  }
  return kinds;
};

/** Drop comments so a structural scan sees only code. */
const stripGlslComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('shader coverage', () => {
  it('has a shader for every render kind', () => {
    const missing = TRANSITION_RENDER_KINDS.filter((k) => GLSL_TRANSITIONS[k] === undefined);
    expect(missing, 'render kinds with no GLSL pass').toEqual([]);
  });

  it('has no shader for a kind outside the enum', () => {
    const known = new Set<string>(TRANSITION_RENDER_KINDS);
    expect(Object.keys(GLSL_TRANSITIONS).filter((k) => !known.has(k))).toEqual([]);
  });

  it('has a numpy twin for every shader', () => {
    const engine = enginePassKinds();
    const missing = TRANSITION_RENDER_KINDS.filter((k) => !engine.has(k));
    expect(missing, 'render kinds with no numpy pass').toEqual([]);
  });

  it('has no numpy pass for a kind the enum does not declare', () => {
    const known = new Set<string>(TRANSITION_RENDER_KINDS);
    expect([...enginePassKinds()].filter((k) => !known.has(k))).toEqual([]);
  });

  it('reaches every render kind from the browsable catalog', () => {
    const reachable = new Set(TRANSITION_CATALOG.map((t) => t.renderKind));
    expect(TRANSITION_RENDER_KINDS.filter((k) => !reachable.has(k))).toEqual([]);
  });
});

describe('uniform indices', () => {
  it('never indexes past what its kind declares', () => {
    // The failure this catches: a pass reads uParams[4] while its kind declares
    // three params, so it silently picks up whatever the last-drawn kind left
    // there — a bug that only appears when two transitions are on screen at once.
    for (const kind of TRANSITION_RENDER_KINDS) {
      const declared = TRANSITION_PARAMS[kind].length;
      const body = stripGlslComments(GLSL_TRANSITIONS[kind]);
      const indices = [...body.matchAll(/uParams\[(\d+)\]/g)].map((m) => Number(m[1]));
      for (const index of indices) {
        expect(index, `${kind} reads uParams[${index}] of ${declared} declared`).toBeLessThan(
          declared,
        );
      }
    }
  });

  it('keeps every kind inside the fixed uniform array', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      expect(TRANSITION_PARAMS[kind].length, kind).toBeLessThanOrEqual(MAX_PARAMS);
    }
  });

  it('reads every param it declares', () => {
    // A declared-but-unread param is a slider the render ignores — the exact
    // dishonesty the kind-aware inspector exists to prevent.
    for (const kind of TRANSITION_RENDER_KINDS) {
      const body = stripGlslComments(GLSL_TRANSITIONS[kind]);
      const read = new Set([...body.matchAll(/uParams\[(\d+)\]/g)].map((m) => Number(m[1])));
      TRANSITION_PARAMS[kind].forEach((descriptor, index) => {
        expect(
          read.has(index),
          `${kind}.${descriptor.name} (uParams[${index}]) is never read`,
        ).toBe(true);
      });
    }
  });
});

describe('universal params', () => {
  // The Inspector builds its controls from these tables. A kind that declares a
  // param its shader never reads gets a slider that moves a number nothing looks
  // at — the exact dishonesty the kind-aware inspector exists to prevent — and a
  // kind that reads one it does not declare gets a value the user cannot reach.
  const usesUniform = (kind: TransitionRenderKind, uniform: string): boolean => {
    const body = stripGlslComments(GLSL_TRANSITIONS[kind]);
    // `rem()` is `(1 - progress) * uIntensity`, so calling it IS reading
    // intensity; likewise `reveal()` and `softness()` for the feather.
    if (uniform === 'uIntensity') return /\buIntensity\b|\brem\s*\(/.test(body);
    return /\buSoftness\b|\bsoftness\s*\(|\breveal\s*\(/.test(body);
  };

  it('declares intensity exactly where the shader reads it', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      expect(readsUniversalParam(kind, 'intensity'), `${kind} intensity`).toBe(
        usesUniform(kind, 'uIntensity'),
      );
    }
  });

  it('declares softness exactly where the shader feathers', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      expect(readsUniversalParam(kind, 'softness'), `${kind} softness`).toBe(
        usesUniform(kind, 'uSoftness'),
      );
    }
  });

  it('declares a direction exactly where the shader reads one', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      const body = stripGlslComments(GLSL_TRANSITIONS[kind]);
      const reads = /\bdirUv\s*\(|\buDirSign\b/.test(body);
      expect(TRANSITION_DIRECTIONS[kind].length > 0, `${kind} direction`).toBe(reads);
    }
  });
});

describe('shader structure', () => {
  const bodies = Object.entries(GLSL_TRANSITIONS) as [TransitionRenderKind, string][];

  it('declares the agreed entry point', () => {
    for (const [kind, body] of bodies) {
      expect(body, kind).toContain('vec4 transition(vec2 uv, float p)');
    }
  });

  it('balances braces and parentheses', () => {
    for (const [kind, body] of bodies) {
      const code = stripGlslComments(body);
      const count = (ch: string): number => code.split(ch).length - 1;
      expect(count('{'), `${kind} braces`).toBe(count('}'));
      expect(count('('), `${kind} parens`).toBe(count(')'));
    }
  });

  it('returns on every path', () => {
    for (const [kind, body] of bodies) {
      expect(stripGlslComments(body), kind).toMatch(/return\s/);
    }
  });

  it('never declares its own uniforms', () => {
    // The preamble owns the uniform block. A pass declaring its own would compile
    // and then read a value the chain never uploads.
    for (const [kind, body] of bodies) {
      expect(stripGlslComments(body), kind).not.toMatch(/\buniform\b/);
    }
  });

  it('uses the shared helpers rather than raw texture() calls', () => {
    // `texture()` skips the CLAMP_TO_EDGE-matching clamp in `tex()`, so a pass
    // using it disagrees with the engine at the frame borders.
    for (const [kind, body] of bodies) {
      expect(stripGlslComments(body), kind).not.toMatch(/(?<!\w)texture\s*\(/);
    }
  });
});

describe('preamble contract', () => {
  it('provides the uniforms every pass is compiled against', () => {
    for (const name of [
      'uTex',
      'uResolution',
      'uProgress',
      'uIntensity',
      'uSoftness',
      'uDirection',
      'uDirSign',
      'uNoiseFrame',
      'uParams',
    ]) {
      expect(TRANSITION_FRAGMENT_PREAMBLE).toContain(name);
    }
  });

  it('sizes the uniform array to MAX_PARAMS', () => {
    expect(TRANSITION_FRAGMENT_PREAMBLE).toContain(`uniform float uParams[${MAX_PARAMS}]`);
  });

  it('calls the entry point and clamps what it writes', () => {
    expect(TRANSITION_FRAGMENT_EPILOGUE).toContain('transition(vUv, uProgress)');
    expect(TRANSITION_FRAGMENT_EPILOGUE).toContain('clamp');
  });

  it('compiles as GLSL ES 3.0 on both stages', () => {
    expect(TRANSITION_VERTEX_SHADER.startsWith('#version 300 es')).toBe(true);
    expect(TRANSITION_FRAGMENT_PREAMBLE.startsWith('#version 300 es')).toBe(true);
  });
});

describe('constants shared with the engine', () => {
  const transitionsPy = readFileSync(join(ENGINE, 'transitions.py'), 'utf8');

  it('agrees with render/transitions.py on the softness ceiling', () => {
    // The one number that decides how wide a feather a softness of 1 buys. If the
    // two drift, every wipe previews with a different edge than it exports.
    expect(transitionsPy).toContain(`_WIPE_SOFTNESS_MAX = ${SOFTNESS_MAX}`);
  });

  it('mirrors the engine’s reveal formula in the preamble', () => {
    // Both sides overshoot the edge to p * (1 + softness) so the feather has
    // cleared the far border by the time progress hits 1.
    expect(TRANSITION_FRAGMENT_PREAMBLE).toContain('p * (1.0 + s)');
    expect(transitionsPy).toContain('p * (1.0 + softness)');
  });
});
