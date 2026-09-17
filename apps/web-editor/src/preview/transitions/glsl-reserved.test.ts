import { describe, expect, it } from 'vitest';
import { GLSL_TRANSITIONS } from './glsl-transitions.js';
import { GLSL_PASSES } from '../effects/glsl-passes.js';

/**
 * Words GLSL ES 3.00 reserves (§3.8). Chromium's desktop compilers accept a few of them as
 * identifiers, but a conformant compiler (SwiftShader, the CI oracle) rejects the whole pass,
 * and the clip then renders untransitioned.
 */
const RESERVED = [
  'active',
  'asm',
  'cast',
  'class',
  'common',
  'double',
  'dvec2',
  'dvec3',
  'dvec4',
  'enum',
  'extern',
  'external',
  'filter',
  'fixed',
  'goto',
  'half',
  'hvec2',
  'hvec3',
  'hvec4',
  'inline',
  'input',
  'interface',
  'long',
  'namespace',
  'noinline',
  'output',
  'packed',
  'partition',
  'public',
  'resource',
  'sample',
  'short',
  'sizeof',
  'static',
  'superp',
  'template',
  'this',
  'typedef',
  'union',
  'unsigned',
  'using',
  'volatile',
];

function declared(source: string): string[] {
  const code = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return RESERVED.filter((word) => new RegExp(`\\b${word}\\b`).test(code));
}

describe('GLSL passes avoid ES 3.00 reserved words', () => {
  it.each(Object.entries(GLSL_TRANSITIONS))('transition %s', (_kind, body) => {
    expect(declared(body)).toEqual([]);
  });
  it.each(Object.entries(GLSL_PASSES))('effect %s', (_kind, body) => {
    expect(declared(body)).toEqual([]);
  });
});
