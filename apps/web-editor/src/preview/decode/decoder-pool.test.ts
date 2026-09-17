import { describe, expect, it } from 'vitest';
import { DecoderPool, type PooledDecoderHolder } from './decoder-pool.js';

class Holder implements PooledDecoderHolder {
  busy = false;
  released = 0;
  constructor(readonly name: string) {}
  releaseDecoder(): void {
    this.released++;
  }
}

describe('DecoderPool', () => {
  it('evicts the least recently used idle holder beyond the cap', () => {
    const pool = new DecoderPool<Holder>(2);
    const [a, b, c] = [new Holder('a'), new Holder('b'), new Holder('c')];
    pool.admit(a);
    pool.admit(b);
    pool.touch(a);
    pool.admit(c);
    expect(b.released).toBe(1);
    expect(a.released).toBe(0);
    expect(pool.size).toBe(2);
  });

  it('never takes a decoder from a busy holder', () => {
    const pool = new DecoderPool<Holder>(1);
    const [a, b] = [new Holder('a'), new Holder('b')];
    pool.admit(a);
    a.busy = true;
    pool.admit(b);
    expect(a.released).toBe(0);
    expect(pool.size).toBe(2);
    a.busy = false;
    pool.admit(b);
    expect(a.released).toBe(1);
    expect(pool.size).toBe(1);
  });

  it('forgets disposed holders', () => {
    const pool = new DecoderPool<Holder>(1);
    const a = new Holder('a');
    pool.admit(a);
    pool.forget(a);
    expect(pool.size).toBe(0);
  });
});
