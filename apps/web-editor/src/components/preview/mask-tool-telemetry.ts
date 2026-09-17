/**
 * Pointer-to-paint telemetry for the monitor mask tools (MK4.6, budget in plan 06: ≤ 16 ms p95
 * while editing a 200-vertex path on 4K footage).
 *
 * **What is measured.** Three channels, all in milliseconds:
 *
 * - `commit` — the pointer event's own timestamp to the instant the overlay's DOM commit is done
 *   and the moved geometry is *paintable*. This is the monitor's own work (input delay, the
 *   gesture math, the store update and React's commit of the 200-point outline) and it is the
 *   quantity the 16 ms budget is about: it is what has to fit inside a frame for the handle to
 *   keep up with the hand.
 * - `pointerToPaint` — the same start, but ending at the animation frame that follows that
 *   commit. It therefore also contains the wait for the next vsync, which the monitor cannot
 *   shorten: a commit finished 1 ms after a vsync still paints ~16 ms later on a 60 Hz display.
 *   Real pointer moves are dispatched frame-aligned by the browser so that wait is small, but
 *   CDP-injected moves (`page.mouse.move` in Playwright) land at arbitrary points in the frame
 *   and add up to a whole frame interval of pure waiting. Recorded and reported, never gated —
 *   see `plan/background-removal-ai/MK4-BUDGETS.md`.
 * - `composite` — the mask raster, which runs asynchronously and latest-wins, so a slow raster
 *   never holds the handle back.
 *
 * The recorder is the monitor's own instrument, not a test harness: the budget spec reads the
 * same numbers an editor's session produces (`window.__fpMaskToolTelemetry` in dev and test).
 */

/** Samples kept per channel; old ones are dropped. */
const RING_SIZE = 512;

export type MaskTelemetryChannel = 'commit' | 'pointerToPaint' | 'composite';

/** A percentile of recorded samples, milliseconds. */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export class MaskToolTelemetry {
  private readonly channels: Record<MaskTelemetryChannel, number[]> = {
    commit: [],
    pointerToPaint: [],
    composite: [],
  };

  /** Record one latency in milliseconds. Non-finite or negative values are ignored. */
  public record(channel: MaskTelemetryChannel, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const samples = this.channels[channel];
    samples.push(milliseconds);
    if (samples.length > RING_SIZE) samples.shift();
  }

  public samples(channel: MaskTelemetryChannel): readonly number[] {
    return this.channels[channel];
  }

  /** p95 of a channel, milliseconds (0 without samples). */
  public p95(channel: MaskTelemetryChannel): number {
    return percentile(this.channels[channel], 0.95);
  }

  public clear(): void {
    this.channels.commit = [];
    this.channels.pointerToPaint = [];
    this.channels.composite = [];
  }
}

/** The monitor's one recorder. */
export const maskToolTelemetry = new MaskToolTelemetry();

if (typeof window !== 'undefined') {
  (window as unknown as { __fpMaskToolTelemetry?: MaskToolTelemetry }).__fpMaskToolTelemetry =
    maskToolTelemetry;
}
