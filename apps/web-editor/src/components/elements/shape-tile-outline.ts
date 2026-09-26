/**
 * Tile-sized outlines for the Shapes tab (plan/elements EL5.1): one SVG path per catalogue
 * generator, so a tile shows the shape it inserts.
 *
 * UI ONLY. The monitor and the export never use these outlines: the engine rasterises every shape
 * (`render/shape_geometry.py`, ADR 0190). They follow the engine's generators closely enough to
 * be recognisable at 64 px — polygons start at the top, stars alternate outer and inner vertices,
 * a ring is cut out even-odd — and are deliberately not pinned to its pixels.
 */
import type { ShapeDescriptor, ShapePreset } from '@framepilot/timeline-schema';

/** A box in tile units: left, top, right, bottom. */
export type TileBox = readonly [number, number, number, number];

/** What a tile draws: the outline, whether it closes (so it can fill), and its fill rule. */
export interface TileOutline {
  readonly d: string;
  readonly fillRule: 'nonzero' | 'evenodd';
  /** Open outlines (corner marks, lines, most icons) only stroke. */
  readonly fills: boolean;
}

const fmt = (value: number): string => String(Math.round(value * 100) / 100);
const at = (box: TileBox, u: number, v: number): readonly [number, number] => [
  box[0] + ((box[2] - box[0]) * u) / 100,
  box[1] + ((box[3] - box[1]) * v) / 100,
];

function polygon(points: readonly (readonly [number, number])[], close = true): string {
  const body = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${fmt(x)} ${fmt(y)}`).join(' ');
  return close ? `${body} Z` : body;
}

function roundedRect(box: TileBox, radius: number): string {
  const [left, top, right, bottom] = box;
  const r = Math.max(0, Math.min(radius, (right - left) / 2, (bottom - top) / 2));
  if (r === 0) {
    return polygon([
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ]);
  }
  return [
    `M ${fmt(left + r)} ${fmt(top)}`,
    `L ${fmt(right - r)} ${fmt(top)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(right)} ${fmt(top + r)}`,
    `L ${fmt(right)} ${fmt(bottom - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(right - r)} ${fmt(bottom)}`,
    `L ${fmt(left + r)} ${fmt(bottom)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(left)} ${fmt(bottom - r)}`,
    `L ${fmt(left)} ${fmt(top + r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(left + r)} ${fmt(top)}`,
    'Z',
  ].join(' ');
}

function ellipse(box: TileBox): string {
  const [left, top, right, bottom] = box;
  const rx = (right - left) / 2;
  const ry = (bottom - top) / 2;
  const cy = top + ry;
  return [
    `M ${fmt(left)} ${fmt(cy)}`,
    `A ${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(right)} ${fmt(cy)}`,
    `A ${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(left)} ${fmt(cy)}`,
    'Z',
  ].join(' ');
}

/** A catalogue path (absolute `M L C Z` on a 0–100 box) mapped onto `box`. */
export function mapCataloguePath(path: string, box: TileBox): string {
  const tokens = path.split(/\s+/).filter((token) => token !== '');
  const out: string[] = [];
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]!;
    const count = command === 'C' ? 3 : command === 'Z' ? 0 : 1;
    const points: string[] = [];
    for (let n = 0; n < count; n += 1) {
      const [x, y] = at(box, Number(tokens[i]), Number(tokens[i + 1]));
      points.push(`${fmt(x)} ${fmt(y)}`);
      i += 2;
    }
    out.push([command, ...points].join(' '));
  }
  return out.join(' ');
}

const knob = (shape: ShapeDescriptor, preset: ShapePreset, name: string): number =>
  preset.knobs?.[name] ?? shape.knobs.find((entry) => entry.name === name)?.default ?? 0;

/**
 * The tile outline of a box shape inside `box`, or `null` while an icon's outline is loading.
 *
 * @param iconPaths - Lucide outlines by icon name, once loaded (`useShapeIconPaths`).
 */
export function boxTileOutline(
  shape: ShapeDescriptor,
  preset: ShapePreset,
  box: TileBox,
  iconPaths: ReadonlyMap<string, string> | null,
): TileOutline | null {
  const [left, top, right, bottom] = box;
  const short = Math.min(right - left, bottom - top);
  const geometry = shape.geometry ?? {};
  const closed = (d: string, fillRule: TileOutline['fillRule'] = 'nonzero'): TileOutline => ({
    d,
    fillRule,
    fills: true,
  });
  switch (shape.generator) {
    case 'rect':
      return closed(roundedRect(box, (short * knob(shape, preset, 'cornerRadius')) / 100));
    case 'ellipse':
      return closed(ellipse(box));
    case 'polygon': {
      const sides = geometry.sides ?? 3;
      const rotation = ((geometry.rotation ?? 0) * Math.PI) / 180;
      const points = Array.from({ length: sides }, (_, i) => {
        const angle = rotation - Math.PI / 2 + (2 * Math.PI * i) / sides;
        return at(box, 50 + 50 * Math.cos(angle), 50 + 50 * Math.sin(angle));
      });
      return closed(polygon(points));
    }
    case 'star': {
      const count = Math.round(knob(shape, preset, 'points'));
      const inner = knob(shape, preset, 'innerRadius') / 100;
      const points = Array.from({ length: count * 2 }, (_, i) => {
        const radius = i % 2 === 0 ? 50 : 50 * inner;
        const angle = -Math.PI / 2 + (Math.PI * i) / count;
        return at(box, 50 + radius * Math.cos(angle), 50 + radius * Math.sin(angle));
      });
      return closed(polygon(points));
    }
    case 'ring': {
      const inset = (short * knob(shape, preset, 'thickness')) / 100;
      const inner: TileBox = [left + inset, top + inset, right - inset, bottom - inset];
      if (geometry.inner === 'ellipse')
        return closed(`${ellipse(box)} ${ellipse(inner)}`, 'evenodd');
      const radius = (short * knob(shape, preset, 'cornerRadius')) / 100;
      return closed(
        `${roundedRect(box, radius)} ${roundedRect(inner, Math.max(0, radius - inset))}`,
        'evenodd',
      );
    }
    case 'bubble': {
      const tail = ((bottom - top) * knob(shape, preset, 'tailSize')) / 100;
      const body: TileBox = [left, top, right, bottom - tail];
      const radius =
        (Math.min(right - left, bottom - tail - top) * knob(shape, preset, 'cornerRadius')) / 100;
      const tipX = left + ((right - left) * knob(shape, preset, 'tailX')) / 100;
      const half = Math.max(2, (right - left) * 0.08);
      const baseX = Math.min(Math.max(tipX, left + radius + half), right - radius - half);
      const tailPath = polygon([
        [baseX - half, bottom - tail - 0.5],
        [tipX, bottom],
        [baseX + half, bottom - tail - 0.5],
      ]);
      return closed(`${roundedRect(body, radius)} ${tailPath}`);
    }
    case 'corners': {
      const length = (short * knob(shape, preset, 'length')) / 100;
      const d = [
        polygon(
          [
            [left, top + length],
            [left, top],
            [left + length, top],
          ],
          false,
        ),
        polygon(
          [
            [right - length, top],
            [right, top],
            [right, top + length],
          ],
          false,
        ),
        polygon(
          [
            [right, bottom - length],
            [right, bottom],
            [right - length, bottom],
          ],
          false,
        ),
        polygon(
          [
            [left + length, bottom],
            [left, bottom],
            [left, bottom - length],
          ],
          false,
        ),
      ].join(' ');
      return { d, fillRule: 'nonzero', fills: false };
    }
    case 'path': {
      const source = geometry.icon !== undefined ? iconPaths?.get(geometry.icon) : geometry.path;
      if (source === undefined) return null;
      return {
        d: mapCataloguePath(source, box),
        fillRule: geometry.fillRule ?? 'nonzero',
        fills: source.includes('Z'),
      };
    }
    case 'segment':
      return null;
  }
}

/** Where a box shape sits in a `size` tile: its default aspect, fitted with a margin. */
export function tileBoxFor(shape: ShapeDescriptor, size: number): TileBox {
  if (shape.frame !== 'box') return [0, 0, size, size];
  const room = size * 0.78;
  const aspect = shape.defaults.width / shape.defaults.height;
  const width = aspect >= 1 ? room : room * aspect;
  const height = aspect >= 1 ? room / aspect : room;
  const [cx, cy] = [size / 2, size / 2];
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}
