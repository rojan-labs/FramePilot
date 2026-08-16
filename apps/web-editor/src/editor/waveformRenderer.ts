/**
 * Pure waveform rendering logic — no React dependencies.
 *
 * Designed for Canvas2D (hardware-accelerated on all modern browsers).
 * LOD aggregation: each pixel-column bar aggregates the min/max amplitude of
 * all peak samples that fall in that column, so the waveform stays accurate at
 * every zoom level. Works with both CanvasRenderingContext2D and
 * OffscreenCanvasRenderingContext2D.
 */

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface WaveformStyle {
  /** Clip background. Default: '#12263A' (dark navy). */
  background: string;
  /** Waveform bar fill. Default: '#3EC8E8' at 82% opacity. */
  barColor: string;
  /** Orange event-marker ticks. Default: '#FF8C42'. */
  markerColor: string;
  /** Physical bar width in px (before DPR scale). Default: 1. */
  barWidth: number;
  /** Physical gap between bars in px. Default: 1. */
  barGap: number;
}

export const DEFAULT_STYLE: Readonly<WaveformStyle> = {
  background: '#0e1e2e',
  barColor: 'rgba(62, 200, 232, 0.84)',
  markerColor: '#FF8C42',
  barWidth: 1,
  barGap: 1,
};

/** Compute max of peaks[from..to). Returns 0 on empty range. */
function maxPeak(peaks: readonly number[], from: number, to: number): number {
  let max = 0;
  for (let j = from; j < to; j++) {
    const v = peaks[j] ?? 0;
    if (v > max) max = v;
  }
  return max;
}

/**
 * Render `peaks` (each normalized 0..1) as vertical bars into `ctx`.
 *
 * @param ctx     Canvas2D context — already scaled for DPR by the caller.
 * @param peaks   Amplitude values, normalized to 0..1.
 * @param width   Logical canvas width (post-DPR-scale, i.e. CSS px × DPR).
 * @param height  Logical canvas height.
 * @param markers Relative event positions (0..1) drawn as orange bottom ticks.
 * @param style   Optional visual overrides.
 */
export function renderWaveform(
  ctx: Ctx2D,
  peaks: readonly number[],
  width: number,
  height: number,
  markers: readonly number[] = [],
  style: Partial<WaveformStyle> = {},
): void {
  const s = { ...DEFAULT_STYLE, ...style };
  const pitch = s.barWidth + s.barGap;
  const numBars = Math.max(1, Math.floor(width / pitch));
  const mid = height / 2;

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = s.background;
  ctx.fillRect(0, 0, width, height);

  // ── Subtle vertical gradient overlay for depth ────────────────────────────
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, 'rgba(255,255,255,0.04)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // ── Waveform bars (LOD-aggregated, 1px wide, symmetric about midline) ─────
  ctx.fillStyle = s.barColor;
  for (let i = 0; i < numBars; i++) {
    const from = Math.floor((i * peaks.length) / numBars);
    const to = Math.min(Math.ceil(((i + 1) * peaks.length) / numBars), peaks.length);
    const amp = maxPeak(peaks, from, to);
    // Min 2px so silent sections still show a hairline — avoids blank voids.
    const barH = Math.max(2, amp * height * 0.88);
    ctx.fillRect(i * pitch, mid - barH / 2, s.barWidth, barH);
  }

  // ── Midline ───────────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(0, mid - 0.5, width, 1);

  // ── Event markers (orange bottom ticks — speech / AI highlight positions) ─
  if (markers.length > 0) {
    const tickH = Math.max(5, Math.round(height * 0.18));
    ctx.fillStyle = s.markerColor;
    for (const t of markers) {
      const x = Math.round(Math.max(0, Math.min(1, t)) * width);
      ctx.fillRect(x - 1, height - tickH, 2, tickH);
    }
  }
}
