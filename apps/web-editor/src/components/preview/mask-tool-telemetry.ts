/**
 * Pointer-to-paint telemetry for the monitor mask tools (MK4.6, budget in plan 06: ≤ 16 ms p95
 * while editing a 200-vertex path on 4K footage).
 *
 * **What is measured.** Five channels, all in milliseconds:
 *
 * - `inputDelay` — the pointer event's own timestamp to the moment the monitor's handler is
 *   entered. Nothing in the monitor happens in this window: it is the browser delivering the
 *   event. Real input is delivered promptly; a `page.mouse.move` injected over CDP is not, so
 *   this channel is what tells the two apart in a measurement.
 * - `work` — handler entry to the paintable DOM: everything the monitor actually does.
 * - `commit` — the pointer event's own timestamp to the instant the overlay's DOM commit is done
 *   and the moved geometry is *paintable* — `inputDelay` + `work`. This is the quantity the
 *   16 ms budget is asserted on.
 * - `pointerToPaint` — the same start, but ending at the animation frame that follows that
 *   commit. Measured on CI it runs 0.1–0.4 ms above `commit`, so the frame wait is not where
 *   this gesture's latency lives. Reported, not gated.
 * - `composite` — the mask raster, which runs asynchronously and latest-wins, so a slow raster
 *   never holds the handle back.
 *
 * The recorder is the monitor's own instrument, not a test harness: the budget spec reads the
 * same numbers an editor's session produces (`window.__fpMaskToolTelemetry` in dev and test).
 */

/** Samples kept per channel; old ones are dropped. */
const RING_SIZE = 512;

export type MaskTelemetryChannel =
  'inputDelay' | 'work' | 'commit' | 'pointerToPaint' | 'composite';

/** A percentile of recorded samples, milliseconds. */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export class MaskToolTelemetry {
  private readonly channels: Record<MaskTelemetryChannel, number[]> = {
    inputDelay: [],
    work: [],
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
    this.channels.inputDelay = [];
    this.channels.work = [];
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
