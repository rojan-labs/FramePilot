import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts every object while preserving array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }, 6] })).toBe(
      '{"a":{"b":3,"y":2},"list":[{"c":5,"d":4},6],"z":1}',
    );
  });

  it('produces the same bytes for insertion-order variants', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});
