#!/usr/bin/env node
/**
 * Build the icon half of the shape catalogue (plan/elements EL5.5) from Lucide (ISC; portions
 * MIT from Feather), which the web editor already depends on (`lucide-react`).
 *
 * Every icon's geometry — paths with arcs and relative commands, circles, rects, lines,
 * polylines, polygons, ellipses — is rewritten as ONE path of absolute `M`, `L`, `C` and `Z`
 * commands on a 0–100 box (Lucide draws on 24x24), because that small vocabulary is all the
 * engine's shape rasteriser reads (`render/shape_raster.py`) and all the Shapes tab's tiles need.
 * Arcs become cubic Béziers (at most 90° each); quadratic and smooth curves become cubics.
 *
 * Writes `packages/timeline-schema/schema/shape-icons.json` and the engine's copy
 * `engine/python/framepilot_engine/render/shape_icons.json`, byte-identical, plus Lucide's
 * licence beside each (the notice travels with the data), and the names alone as
 * `packages/timeline-schema/src/shape-icon-names.ts`: the validators accept `icon/<name>` ids
 * without loading every path. Deterministic: the same Lucide version writes the same bytes;
 * `shape-icons.test.ts` (TS) and `test_shape_icons.py` (engine) pin the outputs to each other.
 *
 * Usage: node scripts/elements/build_icons.mjs
 */
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LUCIDE = join(REPO, 'apps', 'web-editor', 'node_modules', 'lucide-react');
const ICONS_DIR = join(LUCIDE, 'dist', 'esm', 'icons');
const OUTPUTS = [
  join(REPO, 'packages', 'timeline-schema', 'schema'),
  join(REPO, 'engine', 'python', 'framepilot_engine', 'render'),
];
/** Lucide's canvas. */
const VIEW = 24;
const SCALE = 100 / VIEW;

const fmt = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const pt = (x, y) => `${fmt(x * SCALE)} ${fmt(y * SCALE)}`;

/** Tokenise an SVG path's `d`. */
function tokens(d) {
  return d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
}

/** Arc → cubic Béziers (SVG implementation notes F.6). Returns [[c1x,c1y,c2x,c2y,x,y], ...]. */
function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const out = [];
  let t = theta1;
  for (let i = 0; i < segments; i += 1) {
    const a1 = t;
    const a2 = t + step;
    const e1 = [Math.cos(a1), Math.sin(a1)];
    const e2 = [Math.cos(a2), Math.sin(a2)];
    const p = (ex, ey) => [cos * rx * ex - sin * ry * ey + cx, sin * rx * ex + cos * ry * ey + cy];
    const c1 = p(e1[0] - k * e1[1], e1[1] + k * e1[0]);
    const c2 = p(e2[0] + k * e2[1], e2[1] - k * e2[0]);
    const end = p(e2[0], e2[1]);
    out.push([...c1, ...c2, ...end]);
    t = a2;
  }
  return out;
}

/** An SVG path `d` rewritten as absolute M/L/C/Z on the 0–100 box. */
function normalisePath(d) {
  const tk = tokens(d);
  const out = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl = null; // for S/T reflection: [x, y, kind]
  let drawn = false; // the current subpath has drawn since its M and is not closed
  const num = () => Number(tk[i++]);
  // An outline that returns to where it started is closed, whether or not it says Z (Lucide's
  // heart does not): closing it is what lets a filled style fill it, and a round join there
  // looks the same as two round caps.
  const closeIfReturned = () => {
    if (drawn && Math.abs(x - sx) < 1e-3 && Math.abs(y - sy) < 1e-3) out.push('Z');
    drawn = false;
  };
  while (i < tk.length) {
    if (/[a-zA-Z]/.test(tk[i])) cmd = tk[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (C) {
      case 'M': {
        closeIfReturned();
        x = num() + ox;
        y = num() + oy;
        sx = x;
        sy = y;
        out.push(`M ${pt(x, y)}`);
        cmd = rel ? 'l' : 'L';
        lastCtrl = null;
        break;
      }
      case 'L':
        x = num() + ox;
        y = num() + oy;
        out.push(`L ${pt(x, y)}`);
        lastCtrl = null;
        break;
      case 'H':
        x = num() + (rel ? x : 0);
        out.push(`L ${pt(x, y)}`);
        lastCtrl = null;
        break;
      case 'V':
        y = num() + (rel ? y : 0);
        out.push(`L ${pt(x, y)}`);
        lastCtrl = null;
        break;
      case 'C': {
        const c1x = num() + ox;
        const c1y = num() + oy;
        const c2x = num() + ox;
        const c2y = num() + oy;
        x = num() + ox;
        y = num() + oy;
        out.push(`C ${pt(c1x, c1y)} ${pt(c2x, c2y)} ${pt(x, y)}`);
        lastCtrl = [c2x, c2y, 'C'];
        break;
      }
      case 'S': {
        const c1x = lastCtrl?.[2] === 'C' ? 2 * x - lastCtrl[0] : x;
        const c1y = lastCtrl?.[2] === 'C' ? 2 * y - lastCtrl[1] : y;
        const c2x = num() + ox;
        const c2y = num() + oy;
        x = num() + ox;
        y = num() + oy;
        out.push(`C ${pt(c1x, c1y)} ${pt(c2x, c2y)} ${pt(x, y)}`);
        lastCtrl = [c2x, c2y, 'C'];
        break;
      }
      case 'Q':
      case 'T': {
        let qx;
        let qy;
        if (C === 'Q') {
          qx = num() + ox;
          qy = num() + oy;
        } else {
          qx = lastCtrl?.[2] === 'Q' ? 2 * x - lastCtrl[0] : x;
          qy = lastCtrl?.[2] === 'Q' ? 2 * y - lastCtrl[1] : y;
        }
        const ex = num() + ox;
        const ey = num() + oy;
        const c1x = x + (2 / 3) * (qx - x);
        const c1y = y + (2 / 3) * (qy - y);
        const c2x = ex + (2 / 3) * (qx - ex);
        const c2y = ey + (2 / 3) * (qy - ey);
        out.push(`C ${pt(c1x, c1y)} ${pt(c2x, c2y)} ${pt(ex, ey)}`);
        x = ex;
        y = ey;
        lastCtrl = [qx, qy, 'Q'];
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const phi = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const ex = num() + ox;
        const ey = num() + oy;
        for (const [c1x, c1y, c2x, c2y, px, py] of arcToCubics(x, y, rx, ry, phi, large, sweep, ex, ey)) {
          out.push(`C ${pt(c1x, c1y)} ${pt(c2x, c2y)} ${pt(px, py)}`);
        }
        x = ex;
        y = ey;
        lastCtrl = null;
        break;
      }
      case 'Z':
        out.push('Z');
        x = sx;
        y = sy;
        lastCtrl = null;
        drawn = false;
        break;
      default:
        throw new Error(`build_icons: unsupported path command '${cmd}'.`);
    }
    if (C !== 'M' && C !== 'Z') drawn = true;
  }
  closeIfReturned();
  return out;
}

/** An ellipse as four cubic quarter-arcs, starting at its rightmost point. */
function ellipsePath(cx, cy, rx, ry) {
  const k = 0.5522847498;
  const seg = (ax, ay, bx, by, ex, ey) => `C ${pt(ax, ay)} ${pt(bx, by)} ${pt(ex, ey)}`;
  return [
    `M ${pt(cx + rx, cy)}`,
    seg(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry),
    seg(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
    seg(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry),
    seg(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy),
    'Z',
  ];
}

function rectPath(a) {
  const x = Number(a.x ?? 0);
  const y = Number(a.y ?? 0);
  const w = Number(a.width);
  const h = Number(a.height);
  const r = Math.min(Number(a.rx ?? a.ry ?? 0), w / 2, h / 2);
  if (r <= 0) {
    return [`M ${pt(x, y)}`, `L ${pt(x + w, y)}`, `L ${pt(x + w, y + h)}`, `L ${pt(x, y + h)}`, 'Z'];
  }
  const k = 0.5522847498 * r;
  return [
    `M ${pt(x + r, y)}`,
    `L ${pt(x + w - r, y)}`,
    `C ${pt(x + w - r + k, y)} ${pt(x + w, y + r - k)} ${pt(x + w, y + r)}`,
    `L ${pt(x + w, y + h - r)}`,
    `C ${pt(x + w, y + h - r + k)} ${pt(x + w - r + k, y + h)} ${pt(x + w - r, y + h)}`,
    `L ${pt(x + r, y + h)}`,
    `C ${pt(x + r - k, y + h)} ${pt(x, y + h - r + k)} ${pt(x, y + h - r)}`,
    `L ${pt(x, y + r)}`,
    `C ${pt(x, y + r - k)} ${pt(x + r - k, y)} ${pt(x + r, y)}`,
    'Z',
  ];
}

function pointsPath(points, close) {
  const values = String(points).trim().split(/[\s,]+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    out.push(`${i === 0 ? 'M' : 'L'} ${pt(values[i], values[i + 1])}`);
  }
  if (close) out.push('Z');
  return out;
}

function elementPath([tag, attrs]) {
  switch (tag) {
    case 'path':
      return normalisePath(attrs.d);
    case 'circle':
      return ellipsePath(Number(attrs.cx), Number(attrs.cy), Number(attrs.r), Number(attrs.r));
    case 'ellipse':
      return ellipsePath(Number(attrs.cx), Number(attrs.cy), Number(attrs.rx), Number(attrs.ry));
    case 'rect':
      return rectPath(attrs);
    case 'line':
      return [`M ${pt(Number(attrs.x1), Number(attrs.y1))}`, `L ${pt(Number(attrs.x2), Number(attrs.y2))}`];
    case 'polyline':
      return pointsPath(attrs.points, false);
    case 'polygon':
      return pointsPath(attrs.points, true);
    default:
      throw new Error(`build_icons: unsupported element <${tag}>.`);
  }
}

async function main() {
  const files = readdirSync(ICONS_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort();
  const icons = [];
  for (const file of files) {
    const module = await import(pathToFileURL(join(ICONS_DIR, file)).href);
    const node = module.__iconNode;
    if (!Array.isArray(node)) continue;
    const name = file.replace(/\.js$/, '');
    icons.push({ id: `icon/${name}`, name: name.replace(/-/g, ' '), path: node.flatMap(elementPath).join(' ') });
  }
  const version = JSON.parse(readFileSync(join(LUCIDE, 'package.json'), 'utf8')).version;
  const doc = {
    source: `lucide-react ${version} (ISC; portions MIT from Feather). See LICENSE-lucide.txt.`,
    viewBox: 100,
    strokeWidth: 2 * SCALE,
    icons,
  };
  const text = `${JSON.stringify(doc)}\n`;
  for (const dir of OUTPUTS) {
    writeFileSync(join(dir, dir.endsWith('render') ? 'shape_icons.json' : 'shape-icons.json'), text);
    copyFileSync(join(LUCIDE, 'LICENSE'), join(dir, 'LICENSE-lucide.txt'));
  }
  const names = icons.map((icon) => icon.id.slice('icon/'.length)).join(' ');
  writeFileSync(
    join(REPO, 'packages', 'timeline-schema', 'src', 'shape-icon-names.ts'),
    [
      `// Generated by scripts/elements/build_icons.mjs from lucide-react ${version}. Do not edit.`,
      '',
      '/** Every Lucide icon the shape catalogue offers, by the name an `icon/<name>` id takes. */',
      '// prettier-ignore',
      `export const SHAPE_ICON_NAMES: readonly string[] = '${names}'.split(' ');`,
      '',
    ].join('\n'),
  );
  process.stdout.write(`build_icons: ${icons.length} icons from lucide-react ${version}\n`);
}

await main();
