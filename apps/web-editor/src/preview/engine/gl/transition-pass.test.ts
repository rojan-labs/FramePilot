import { describe, expect, it } from 'vitest';
import { transitionPassSource } from './transition-pass.js';

describe('compositor transition passes', () => {
  it('evaluates array-index noise passes at integer top-down pixel indices, like numpy', () => {
    for (const kind of ['noise-dissolve', 'pixel-dissolve', 'warp'] as const) {
      const source = transitionPassSource(kind)!;
      expect(source).not.toContain('uv * uResolution');
      expect(source).toContain('floor(gl_FragCoord.xy)');
    }
  });

  it('leaves UV-grid passes on pixel centres', () => {
    expect(transitionPassSource('mosaic')).toContain('uv.x * uResolution.x');
  });
});
