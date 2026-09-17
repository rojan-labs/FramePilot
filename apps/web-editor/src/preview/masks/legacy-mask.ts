/**
 * The `gaussian-legacy` mask path, reproduced: `render/masks.py#rasterize_mask` (MK3.2).
 *
 * WHY Pillow and not the exact rasteriser: masks migrated from schema v21 keep the v21
 * renderer so an existing project exports byte-identically (ADR 0178). The preview has to draw
 * what that export draws, so this is a port of the Pillow 12 code it runs:
 *
 * - `ImageDraw.rectangle` / `ellipse` / `polygon` with `fill=255` on an `L` image
 *   (`libImaging/Draw.c`: `ImagingDrawRectangle`, `ellipseNew` + `quarter_*`/`ellipse_*`,
 *   `ImagingDrawPolygon` + `polygon_generic`), coordinates truncated with C `(int)`;
 * - `ImageFilter.GaussianBlur(radius)`: three extended box passes per axis
 *   (`libImaging/BoxBlur.c`, `_gaussian_blur_radius`).
 *
 * Pillow's polygon engine computes in C `float`; every such step goes through `Math.fround`
 * in the same order. Checked byte for byte against Pillow in `legacy-mask.test.ts`
 * (`tests/fixtures/mask-raster/legacy.json`).
 *
 * PLATFORM FACT (measured, not assumed): Pillow's macOS arm64 wheels are built by clang with
 * floating-point contraction, so `(y - y0) * dx + x0` in `polygon_generic` is ONE fused
 * multiply-add there and two rounded steps on Linux and Windows x64. The engine itself therefore
 * fills a different pixel on the two where a polygon edge crosses a row at exactly `.5` (see the
 * contraction test). The preview follows the engine on the SAME machine: {@link
 * setPillowFloatContraction} is set from the host at startup, and each mode is tested.
 */

/** A resolved v21 mask (`render/masks.py#MaskSpec`); geometry in frame fractions. */
export interface LegacyMaskSpec {
  readonly shape: 'rectangle' | 'ellipse' | 'polygon';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly feather: number;
  readonly opacity: number;
  readonly invert: boolean;
  readonly points: readonly (readonly [number, number])[];
}

const f32 = Math.fround;

/** Whether the host's Pillow fuses multiply-add in C float code (macOS arm64 wheels do). */
let pillowContracts = false;

/**
 * Set how the host's Pillow evaluates `a * b + c` in C float code: fused (macOS arm64) or in
 * two rounded steps (Linux, Windows, Intel macOS).
 */
export function setPillowFloatContraction(fused: boolean): void {
  pillowContracts = fused;
}

/** Options for the Pillow port; defaults follow {@link setPillowFloatContraction}. */
export interface PillowArithmetic {
  readonly contract: boolean;
}

/** C `(int)` of a double: truncation toward zero. */
const cInt = (value: number): number => Math.trunc(value);

/** `hline8`: fill `[x0, x1]` on row `y0`, clamped to the image. */
function hline(
  pixels: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
): void {
  if (y0 < 0 || y0 >= height) return;
  let start = x0;
  let end = x1;
  if (start < 0) start = 0;
  else if (start >= width) return;
  if (end < 0) return;
  if (end >= width) end = width - 1;
  if (start <= end) pixels.fill(255, y0 * width + start, y0 * width + end + 1);
}

function drawRectangle(
  pixels: Uint8Array,
  width: number,
  height: number,
  box: readonly number[],
): void {
  const x0 = cInt(box[0]!);
  let y0 = cInt(box[1]!);
  const x1 = cInt(box[2]!);
  let y1 = cInt(box[3]!);
  if (y0 > y1) [y0, y1] = [y1, y0];
  if (y0 < 0) y0 = 0;
  else if (y0 >= height) return;
  if (y1 < 0) return;
  if (y1 > height) y1 = height;
  for (let y = y0; y <= y1; y += 1) hline(pixels, width, height, x0, y, x1);
}

// --- Ellipse (quarter_* / ellipse_*) ---------------------------------------------------

interface QuarterState {
  a: number;
  b: number;
  cx: number;
  cy: number;
  ex: number;
  ey: number;
  a2: number;
  b2: number;
  a2b2: number;
  finished: boolean;
}

function quarterInit(a: number, b: number): QuarterState {
  if (a < 0 || b < 0) {
    return { a: 0, b: 0, cx: 0, cy: 0, ex: 0, ey: 0, a2: 0, b2: 0, a2b2: 0, finished: true };
  }
  const a2 = a * a;
  const b2 = b * b;
  return { a, b, cx: a, cy: b % 2, ex: a % 2, ey: b, a2, b2, a2b2: a2 * b2, finished: false };
}

function quarterDelta(s: QuarterState, x: number, y: number): number {
  // int64 in C; exact in doubles while a²b² < 2^53 (ellipses up to ~9000 px across).
  return Math.abs(s.a2 * y * y + s.b2 * x * x - s.a2b2);
}

function quarterNext(s: QuarterState): [number, number] | null {
  if (s.finished) return null;
  const point: [number, number] = [s.cx, s.cy];
  if (s.cx === s.ex && s.cy === s.ey) {
    s.finished = true;
  } else {
    let nx = s.cx;
    let ny = s.cy + 2;
    let ndelta = quarterDelta(s, nx, ny);
    if (nx > 1) {
      let newdelta = quarterDelta(s, s.cx - 2, s.cy + 2);
      if (ndelta > newdelta) {
        nx = s.cx - 2;
        ny = s.cy + 2;
        ndelta = newdelta;
      }
      newdelta = quarterDelta(s, s.cx - 2, s.cy);
      if (ndelta > newdelta) {
        nx = s.cx - 2;
        ny = s.cy;
      }
    }
    s.cx = nx;
    s.cy = ny;
  }
  return point;
}

function drawEllipse(
  pixels: Uint8Array,
  width: number,
  height: number,
  box: readonly number[],
): void {
  const x0 = cInt(box[0]!);
  const y0 = cInt(box[1]!);
  const a = cInt(box[2]!) - x0;
  const b = cInt(box[3]!) - y0;
  if (a < 0 || b < 0) return;
  const w = a + b;
  // ellipse_init
  const leftmost = a % 2;
  const outer = quarterInit(a, b);
  const first = w < 1 ? null : quarterNext(outer);
  if (first === null) return;
  let [pr, py] = first;
  const inner = quarterInit(a - 2 * (w - 1), b - 2 * (w - 1));
  let pl = leftmost;
  let finished = false;
  const emit = (l: number, y: number, r: number): void =>
    hline(
      pixels,
      width,
      height,
      x0 + cInt((l + a) / 2),
      y0 + cInt((y + b) / 2),
      x0 + cInt((r + a) / 2),
    );
  // ellipse_next, draining its buffer in the same (reverse) order.
  for (;;) {
    if (finished) return;
    const y = py;
    let l = pl;
    const r = pr;
    let next: [number, number] | null;
    for (;;) {
      next = quarterNext(outer);
      if (next === null || next[1] > y) break;
    }
    if (next === null) finished = true;
    else [pr, py] = next;
    for (;;) {
      next = quarterNext(inner);
      if (next === null || next[1] > y) break;
      l = next[0];
    }
    pl = next === null ? leftmost : next[0];
    const buffer: [number, number, number][] = [];
    if ((l > 0 || l < r) && y > 0) buffer.push([l === 0 ? 2 : l, y, r]);
    if (y > 0) buffer.push([-r, y, -l]);
    if (l > 0 || l < r) buffer.push([l === 0 ? 2 : l, -y, r]);
    buffer.push([-r, -y, -l]);
    for (let i = buffer.length - 1; i >= 0; i -= 1)
      emit(buffer[i]![0], buffer[i]![1], buffer[i]![2]);
  }
}

// --- Polygon (polygon_generic, float arithmetic) -------------------------------------------

interface Edge {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  x0: number;
  y0: number;
  dx: number;
}

function addEdge(x0: number, y0: number, x1: number, y1: number): Edge {
  return {
    xmin: Math.min(x0, x1),
    xmax: Math.max(x0, x1),
    ymin: Math.min(y0, y1),
    ymax: Math.max(y0, y1),
    x0,
    y0,
    dx: y0 === y1 ? 0 : f32(f32(x1 - x0) / (y1 - y0)),
  };
}

/**
 * `(y - e->y0) * e->dx + e->x0` in C float. Fused, the double product of a float and a small
 * integer is exact, so one `fround` of the double sum is the single rounding FMA performs.
 */
const edgeX = (edge: Edge, y: number, contract: boolean): number =>
  contract
    ? f32((y - edge.y0) * edge.dx + edge.x0)
    : f32(f32(f32(y - edge.y0) * edge.dx) + edge.x0);

/** C `roundf`: half away from zero. */
const roundf = (value: number): number => {
  const v = f32(value);
  return v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
};

const roundUp = (value: number): number =>
  value >= 0 ? Math.floor(f32(value + 0.5)) : -Math.floor(f32(Math.abs(value) + 0.5));
const roundDown = (value: number): number =>
  value >= 0 ? Math.ceil(f32(value - 0.5)) : -Math.ceil(f32(Math.abs(value) - 0.5));

function drawPolygon(
  pixels: Uint8Array,
  width: number,
  height: number,
  xy: readonly number[],
  contract: boolean,
): void {
  const count = xy.length / 2;
  if (count <= 0) return;
  const edges: Edge[] = [];
  let i = 0;
  for (; i < count - 1; i += 1) {
    const x0 = xy[i * 2]!;
    const y0 = xy[i * 2 + 1]!;
    const x1 = xy[i * 2 + 2]!;
    const y1 = xy[i * 2 + 3]!;
    if (y0 === y1 && i !== 0 && y0 === xy[i * 2 - 1]) {
      const last = edges[edges.length - 1]!;
      if (x1 > x0 && x0 > xy[i * 2 - 2]!) {
        last.xmax = x1;
        continue;
      } else if (x1 < x0 && x0 < xy[i * 2 - 2]!) {
        last.xmin = x1;
        continue;
      }
    }
    edges.push(addEdge(x0, y0, x1, y1));
  }
  if (xy[i * 2] !== xy[0] || xy[i * 2 + 1] !== xy[1]) {
    edges.push(addEdge(xy[i * 2]!, xy[i * 2 + 1]!, xy[0]!, xy[1]!));
  }

  // polygon_generic (non-alpha `hline8` branch)
  const table: Edge[] = [];
  let ymin = height - 1;
  let ymax = 0;
  for (const edge of edges) {
    if (ymin > edge.ymin) ymin = edge.ymin;
    if (ymax < edge.ymax) ymax = edge.ymax;
    if (edge.ymin === edge.ymax) {
      hline(pixels, width, height, edge.xmin, edge.ymin, edge.xmax);
      continue;
    }
    table.push(edge);
  }
  if (ymin < 0) ymin = 0;
  if (ymax > height) ymax = height;
  const xx: number[] = [];
  for (; ymin <= ymax; ymin += 1) {
    xx.length = 0;
    for (let e = 0; e < table.length; e += 1) {
      const current = table[e]!;
      if (!(ymin >= current.ymin && ymin <= current.ymax)) continue;
      xx.push(edgeX(current, ymin, contract));
      if (ymin === current.ymax && ymin < ymax) {
        xx.push(xx[xx.length - 1]!);
      } else if ((ymin === current.ymin || ymin === current.ymax) && current.dx !== 0) {
        for (let k = 0; k < e; k += 1) {
          const other = table[k]!;
          if ((ymin !== other.ymin && ymin !== other.ymax) || other.dx === 0) continue;
          if (roundf(xx[xx.length - 1]!) === roundf(edgeX(other, ymin, contract))) {
            const offset = ymin === current.ymax ? -1 : 1;
            const adjacent = edgeX(current, ymin + offset, contract);
            if (ymin + offset >= other.ymin && ymin + offset <= other.ymax) {
              const adjacentOther = edgeX(other, ymin + offset, contract);
              const last = xx[xx.length - 1]!;
              if (last > f32(adjacent + 1) && last > f32(adjacentOther + 1)) {
                xx[xx.length - 1] = f32(roundf(Math.max(adjacent, adjacentOther)) + 1);
              } else if (last < f32(adjacent - 1) && last < f32(adjacentOther - 1)) {
                xx[xx.length - 1] = f32(roundf(Math.min(adjacent, adjacentOther)) - 1);
              }
              break;
            }
          }
        }
      }
    }
    xx.sort((p, q) => p - q);
    for (let k = 1; k < xx.length; k += 2) {
      hline(pixels, width, height, roundUp(xx[k - 1]!), ymin, roundDown(xx[k]!));
    }
  }
}

// --- GaussianBlur (BoxBlur.c) ----------------------------------------------------------------

/** `_gaussian_blur_radius(radius, 3)`, with C's float/double mix. */
function gaussianBoxRadius(radius: number, contract: boolean, passes = 3): number {
  const r = f32(radius);
  const sigma2 = f32(f32(r * r) / passes);
  // `12.0 * sigma2` is exact in double, so contraction cannot change L.
  const L = f32(Math.sqrt(12.0 * sigma2 + 1.0));
  const l = f32(Math.floor((L - 1.0) / 2.0));
  // `l * (l + 1)` is an exact small integer; fused, `3 * sigma2` is not rounded on its own.
  const spread = contract
    ? f32(f32(l * f32(l + 1)) - 3 * sigma2)
    : f32(f32(l * f32(l + 1)) - f32(3 * sigma2));
  let a = f32(f32(f32(2 * l) + 1) * spread);
  a = f32(a / f32(6 * f32(sigma2 - f32(f32(l + 1) * f32(l + 1)))));
  return f32(l + a);
}

/** One `ImagingLineBoxBlur8` over `count` samples at `offset + i * stride`, in place. */
function boxBlurLine(
  data: Uint8Array,
  offset: number,
  stride: number,
  count: number,
  floatRadius: number,
  scratch: Uint8Array,
): void {
  const radius = Math.trunc(floatRadius);
  const ww = Math.trunc(f32(16777216 / f32(floatRadius * 2 + 1)));
  const fw = Math.trunc((16777216 - (radius * 2 + 1) * ww) / 2);
  const lastx = count - 1;
  const edgeA = Math.min(radius + 1, count);
  const edgeB = Math.max(count - radius - 1, 0);
  const line = scratch;
  for (let i = 0; i < count; i += 1) line[i] = data[offset + i * stride]!;
  const at = (i: number): number => line[i]!;
  const save = (x: number, bulk: number): void => {
    data[offset + x * stride] = Math.floor((bulk + 8388608) / 16777216) & 0xff;
  };
  let acc = at(0) * (radius + 1);
  for (let x = 0; x < edgeA - 1; x += 1) acc += at(x);
  acc += at(lastx) * (radius - edgeA + 1);
  const step = (x: number, subtract: number, add: number, left: number, right: number): void => {
    acc += at(add) - at(subtract);
    save(x, acc * ww + (at(left) + at(right)) * fw);
  };
  if (edgeA <= edgeB) {
    for (let x = 0; x < edgeA; x += 1) step(x, 0, x + radius, 0, x + radius + 1);
    for (let x = edgeA; x < edgeB; x += 1)
      step(x, x - radius - 1, x + radius, x - radius - 1, x + radius + 1);
    for (let x = edgeB; x <= lastx; x += 1) step(x, x - radius - 1, lastx, x - radius - 1, lastx);
  } else {
    for (let x = 0; x < edgeB; x += 1) step(x, 0, x + radius, 0, x + radius + 1);
    for (let x = edgeB; x < edgeA; x += 1) step(x, 0, lastx, 0, lastx);
    for (let x = edgeA; x <= lastx; x += 1) step(x, x - radius - 1, lastx, x - radius - 1, lastx);
  }
}

/** `image.filter(ImageFilter.GaussianBlur(radius))` on an `L` image, in place. */
export function pilGaussianBlurL(
  pixels: Uint8Array,
  width: number,
  height: number,
  radius: number,
  arithmetic: PillowArithmetic = { contract: pillowContracts },
): void {
  if (width === 0 || height === 0) return;
  const box = gaussianBoxRadius(radius, arithmetic.contract);
  if (box === 0) return;
  const scratch = new Uint8Array(Math.max(width, height));
  for (let pass = 0; pass < 3; pass += 1) {
    for (let y = 0; y < height; y += 1) boxBlurLine(pixels, y * width, 1, width, box, scratch);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    for (let x = 0; x < width; x += 1) boxBlurLine(pixels, x, width, height, box, scratch);
  }
}

// --- rasterize_mask ---------------------------------------------------------------------------

/** The Pillow `L` bytes of a spec before invert and opacity (row-major, 0..255). */
export function legacyMaskPixels(
  spec: LegacyMaskSpec,
  width: number,
  height: number,
  arithmetic: PillowArithmetic = { contract: pillowContracts },
): Uint8Array {
  const pixels = new Uint8Array(width * height);
  if (spec.shape === 'polygon' && spec.points.length >= 3) {
    const xy: number[] = [];
    for (const [px, py] of spec.points) xy.push(cInt(px * width), cInt(py * height));
    drawPolygon(pixels, width, height, xy, arithmetic.contract);
  } else {
    const left = spec.x * width;
    const top = spec.y * height;
    const right = (spec.x + spec.width) * width;
    const bottom = (spec.y + spec.height) * height;
    const box = [left, top, Math.max(left, right - 1), Math.max(top, bottom - 1)];
    if (spec.shape === 'ellipse') drawEllipse(pixels, width, height, box);
    else drawRectangle(pixels, width, height, box);
  }
  if (spec.feather > 0.0) {
    pilGaussianBlurL(pixels, width, height, spec.feather * Math.min(width, height), arithmetic);
  }
  return pixels;
}

/** `rasterize_mask` as float64 alpha: `p / 255`, inverted, times the clamped opacity. */
export function legacyMaskAlpha(
  spec: LegacyMaskSpec,
  width: number,
  height: number,
  arithmetic: PillowArithmetic = { contract: pillowContracts },
): Float64Array {
  const pixels = legacyMaskPixels(spec, width, height, arithmetic);
  const opacity = spec.opacity <= 0.0 ? 0.0 : spec.opacity >= 1.0 ? 1.0 : spec.opacity;
  const alpha = new Float64Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 1) {
    const value = pixels[i]! / 255.0;
    alpha[i] = (spec.invert ? 1.0 - value : value) * opacity;
  }
  return alpha;
}
