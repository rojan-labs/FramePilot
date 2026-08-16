/** Keep a one-pixel moving line on the physical pixel grid. */
export function alignToDevicePixel(cssPx: number, devicePixelRatio: number): number {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.round(cssPx * scale) / scale;
}
