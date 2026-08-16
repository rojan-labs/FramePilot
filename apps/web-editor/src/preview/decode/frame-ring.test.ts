import { describe, expect, it, vi } from 'vitest';
import { FrameRing, type Closable } from './frame-ring.js';

function fakeFrame(timestamp: number): Closable & { closed: boolean } {
  const frame = { timestamp, closed: false, close: vi.fn() };
  frame.close.mockImplementation(() => {
    frame.closed = true;
  });
  return frame;
}

describe('FrameRing', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new FrameRing(0)).toThrow('capacity must be >= 1');
  });

  it('tracks size and push/close accounting under capacity', () => {
    const ring = new FrameRing<Closable>(4);
    ring.push(fakeFrame(0));
    ring.push(fakeFrame(1));
    expect(ring.size).toBe(2);
    const stats = ring.stats();
    expect(stats.framesPushed).toBe(2);
    expect(stats.framesClosed).toBe(0);
    expect(stats.inFlightNow).toBe(2);
    expect(stats.inFlightPeak).toBe(2);
  });

  it('evicts and closes the oldest frame once over capacity', () => {
    const ring = new FrameRing<Closable & { closed: boolean }>(2);
    const a = fakeFrame(0);
    const b = fakeFrame(1);
    const c = fakeFrame(2);
    ring.push(a);
    ring.push(b);
    ring.push(c); // evicts a
    expect(a.closed).toBe(true);
    expect(ring.size).toBe(2);
    expect(ring.stats().framesClosed).toBe(1);
    // Peak is the momentary high-water mark BEFORE eviction kicks in (3 frames
    // briefly existed at once) — this is the honest number for gate #5.
    expect(ring.stats().inFlightPeak).toBe(3);
  });

  it('frameAt returns the latest frame at-or-before the target, not the future one', () => {
    const ring = new FrameRing<Closable>(10);
    ring.push(fakeFrame(0));
    ring.push(fakeFrame(1000));
    ring.push(fakeFrame(2000));
    expect(ring.frameAt(1500)?.timestamp).toBe(1000);
    expect(ring.frameAt(2000)?.timestamp).toBe(2000);
    expect(ring.frameAt(-1)).toBeUndefined();
  });

  it('evictBefore closes stale frames but always keeps the current one', () => {
    const ring = new FrameRing<Closable & { closed: boolean }>(10);
    const a = fakeFrame(0);
    const b = fakeFrame(1000);
    const c = fakeFrame(2000);
    ring.push(a);
    ring.push(b);
    ring.push(c);
    ring.evictBefore(1500); // a and b are both <= 1500... but b is index 1 (kept as "current")
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false); // never evicts index 0 alone away from "keep the current"
    expect(ring.size).toBe(2);
  });

  it('evictBefore is a no-op with fewer than 2 frames', () => {
    const ring = new FrameRing<Closable & { closed: boolean }>(10);
    const a = fakeFrame(0);
    ring.push(a);
    ring.evictBefore(999999);
    expect(a.closed).toBe(false);
    expect(ring.size).toBe(1);
  });

  it('clear() closes every held frame and empties the ring', () => {
    const ring = new FrameRing<Closable & { closed: boolean }>(10);
    const frames = [fakeFrame(0), fakeFrame(1), fakeFrame(2)];
    frames.forEach((f) => ring.push(f));
    ring.clear();
    expect(frames.every((f) => f.closed)).toBe(true);
    expect(ring.size).toBe(0);
    expect(ring.stats().framesClosed).toBe(3);
  });
});
