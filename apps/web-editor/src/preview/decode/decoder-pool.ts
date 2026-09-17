/**
 * A cap on live `VideoDecoder` instances across every loaded source (PX2.4).
 *
 * Each source keeps one decoder so contiguous playback streams without reseeking, but Chrome
 * limits concurrent (hardware) decoders and a timeline with many sources would otherwise hold
 * one per source for as long as the source stays loaded. When a new decoder is needed and the cap
 * is reached, the least recently used idle holder gives its decoder up; its next request simply
 * reseeks from a keyframe.
 */
export interface PooledDecoderHolder {
  /** True while a decode call is running (its decoder must not be taken). */
  readonly busy: boolean;
  /** Close the decoder and forget the stream position. */
  releaseDecoder(): void;
}

/** Enough for a five-layer stack plus a transition's incoming source. */
export const MAX_LIVE_DECODERS = 6;

export class DecoderPool<T extends PooledDecoderHolder> {
  /** Holders with a live decoder, least recently used first. */
  private readonly live = new Set<T>();

  constructor(private readonly capacity: number = MAX_LIVE_DECODERS) {}

  /** Mark `holder` used; call before it creates or uses its decoder. */
  touch(holder: T): void {
    this.live.delete(holder);
    this.live.add(holder);
  }

  /** Make room for `holder` to create a decoder, evicting idle holders beyond the cap. */
  admit(holder: T): void {
    this.touch(holder);
    for (const other of this.live) {
      if (this.live.size <= this.capacity) break;
      if (other === holder || other.busy) continue;
      this.live.delete(other);
      other.releaseDecoder();
    }
  }

  /** `holder` closed its decoder on its own (dispose). */
  forget(holder: T): void {
    this.live.delete(holder);
  }

  get size(): number {
    return this.live.size;
  }
}
