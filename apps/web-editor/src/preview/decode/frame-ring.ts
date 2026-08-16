/**
 * Bounded decoded-frame queue with `.close()` discipline (plan
 * PREVIEW-WEBCODECS-COMPOSITOR.md P0 gate #5 — resource hygiene).
 *
 * `VideoFrame`s are GPU-backed; every one must be `.close()`d promptly or the
 * decoder can silently deadlock (Chromium holds a small output-frame pool).
 * This ring is deliberately generic over anything `Closable` (real
 * `VideoFrame` in the browser, a fake in unit tests) so its accounting logic
 * — the actual thing that must never be wrong — is testable without a real
 * decoder or DOM.
 */

export interface Closable {
  readonly timestamp: number;
  close(): void;
}

export interface FrameRingStats {
  /** Frames currently held (not yet evicted or explicitly closed by the consumer). */
  inFlightNow: number;
  /** High-water mark of `inFlightNow` since construction (or `resetStats()`). */
  inFlightPeak: number;
  framesPushed: number;
  framesClosed: number;
}

/**
 * A capacity-bounded FIFO of decoded frames, ordered by push order (callers
 * must push in presentation-timestamp order — the decoder output callback
 * already guarantees this when there are no B-frames, see the P-1 proxy
 * spec's `-bf 0`).
 */
export class FrameRing<T extends Closable> {
  private readonly frames: T[] = [];
  private framesPushed = 0;
  private framesClosed = 0;
  private inFlightPeak = 0;

  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error(`FrameRing capacity must be >= 1, got ${capacity}.`);
    }
  }

  /** Push a newly decoded frame; evicts (and closes) the oldest frame if over capacity. */
  push(frame: T): void {
    this.frames.push(frame);
    this.framesPushed++;
    if (this.frames.length > this.inFlightPeak) {
      this.inFlightPeak = this.frames.length;
    }
    if (this.frames.length > this.capacity) {
      const evicted = this.frames.shift();
      evicted?.close();
      this.framesClosed++;
    }
  }

  /** The frame whose `[timestamp, timestamp + duration)` window is closest at-or-before `mediaTimeUs`, or undefined if none queued yet is old enough. */
  frameAt(mediaTimeUs: number): T | undefined {
    let candidate: T | undefined;
    for (const frame of this.frames) {
      if (frame.timestamp <= mediaTimeUs) {
        candidate = frame;
      } else {
        break;
      }
    }
    return candidate;
  }

  /** Drop and close every frame at or before `mediaTimeUs`, EXCEPT the most recent such frame (kept as the currently-presented one). */
  evictBefore(mediaTimeUs: number): void {
    for (;;) {
      const next = this.frames[1];
      if (this.frames.length <= 1 || !next || next.timestamp > mediaTimeUs) break;
      const evicted = this.frames.shift();
      evicted?.close();
      this.framesClosed++;
    }
  }

  /** Close and discard every held frame — call on seek/reset/teardown. */
  clear(): void {
    for (const frame of this.frames) {
      frame.close();
      this.framesClosed++;
    }
    this.frames.length = 0;
  }

  get size(): number {
    return this.frames.length;
  }

  stats(): FrameRingStats {
    return {
      inFlightNow: this.frames.length,
      inFlightPeak: this.inFlightPeak,
      framesPushed: this.framesPushed,
      framesClosed: this.framesClosed,
    };
  }
}
