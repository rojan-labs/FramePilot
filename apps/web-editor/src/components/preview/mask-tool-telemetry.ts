/**
 * Pointer-to-paint telemetry for the monitor mask tools (MK4.6, budget in plan 06: ≤ 16 ms p95
 * while editing a 200-vertex path on 4K footage).
 *
 * **What is measured.** From the pointer event's own timestamp to the animation frame that
 * follows the overlay's DOM commit, which is the frame that paints the moved geometry. The
 * composited mask preview is re-rastered asynchronously and latest-wins (a slow raster never
 * blocks the handle following the hand), so it is recorded separately as `composite` latency.
 *
 * The recorder is the monitor's own instrument, not a test harness: the budget spec reads the
 * same numbers an editor's session produces (`window.__fpMaskToolTelemetry` in dev and test).
 */

/** Samples kept per channel; old ones are dropped. */
const RING_SIZE = 512;

export type MaskTelemetryChannel = 'pointerToPaint' | 'composite';

/** A percentile of recorded samples, milliseconds. */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export class MaskToolTelemetry {
  private readonly channels: Record<MaskTelemetryChannel, number[]> = {
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
