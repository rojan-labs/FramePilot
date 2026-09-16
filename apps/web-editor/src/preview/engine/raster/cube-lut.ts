/**
 * `.cube` 3D LUT parsing for the preview, mirroring `render/color.py` `parse_cube_lut` (PX2.2):
 * same accepted keywords, same refusals, same `[r, g, b]` table orientation, so the GPU applies
 * the table the export applies.
 */

export interface CubeLut {
  readonly size: number;
  /** `size³ × 3` floats, index `r + g·size + b·size²` (red varies fastest, as in the file). */
  readonly table: Float32Array;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
}

/**
 * Parse `.cube` text.
 *
 * @throws Error for a 1D LUT, a missing `LUT_3D_SIZE`, or an entry-count mismatch.
 */
export function parseCubeLut(text: string): CubeLut {
  let size: number | null = null;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const rows: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0]!.toUpperCase();
    if (key === 'TITLE') continue;
    if (key === 'LUT_1D_SIZE')
      throw new Error('1D .cube LUTs are not supported (a 3D LUT is required).');
    if (key === 'LUT_3D_SIZE') {
      size = Number.parseInt(parts[1] ?? '', 10);
      continue;
    }
    if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      const values = parts.slice(1, 4).map(Number) as [number, number, number];
      if (key === 'DOMAIN_MIN') domainMin = values;
      else domainMax = values;
      continue;
    }
    if (parts.length === 3) rows.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (size === null || !Number.isFinite(size))
    throw new Error('Missing LUT_3D_SIZE in .cube data.');
  const count = rows.length / 3;
  if (count !== size ** 3) {
    throw new Error(`.cube has ${count} entries, expected ${size ** 3} for size ${size}.`);
  }
  return { size, table: Float32Array.from(rows), domainMin, domainMax };
}
