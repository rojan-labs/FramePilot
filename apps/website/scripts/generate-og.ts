/**
 * Generates all brand raster assets for the site into `public/`:
 *   - og.png            1200×630 Open Graph / Twitter card
 *   - icon-192.png      PWA icon
 *   - icon-512.png      PWA icon
 *   - apple-touch-icon.png  180×180
 *   - icon.svg          scalable favicon
 *   - favicon.ico       32×32 (PNG-embedded ICO)
 *
 * FramePilot brand: warm paper field, ink type, and orange as the single action
 * colour, matching the site's "ripple delete" direction (ADR 0172, ADR 0054).
 * The card is laid out as a strip of timeline: an in point opens it and a ruler
 * with a playhead closes it. The mark itself is the real logo (public/logo.png),
 * embedded.
 * Uses @resvg/resvg-js with system fonts (works offline).
 * Run manually with `pnpm generate:og` whenever the brand changes.
 */
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
mkdirSync(PUBLIC, { recursive: true });

const PAPER = '#fbfaf7';
const INK = '#17140f';
const INK_SOFT = '#5c574c';
const INK_FAINT = '#a9a294';
const RULE = '#d9d5cc';
const RULE_STRONG = '#b4afa3';
const ACCENT = '#f26522';
const FONT = 'Helvetica, Arial, sans-serif';
const MONO = 'Courier, monospace';

/** The real logo PNG, embedded as a data URI so the mark is pixel-identical to
 *  the app icon and the nav logo everywhere. */
const LOGO_DATA_URI = `data:image/png;base64,${readFileSync(resolve(PUBLIC, 'logo.png')).toString('base64')}`;

/**
 * The FramePilot brand mark — the logo, drawn into a rounded tile so it reads as
 * the app icon (matches src/components/Logo.tsx and the editor favicon).
 */
function markSvg(size: number, radius: number): string {
  const s = size;
  return `
    <clipPath id="clip${s}"><rect x="0" y="0" width="${s}" height="${s}" rx="${radius}"/></clipPath>
    <image href="${LOGO_DATA_URI}" x="0" y="0" width="${s}" height="${s}" clip-path="url(#clip${s})" preserveAspectRatio="xMidYMid slice"/>`;
}

/** A row of timeline ruler ticks: the same rule that divides every section. */
function ticksSvg(width: number, step = 22, height = 16): string {
  let out = '';
  for (let x = 0; x <= width; x += step) {
    const major = x % (step * 5) === 0;
    out += `<rect x="${x}" y="0" width="1.5" height="${major ? height : height - 7}" fill="${
      major ? RULE_STRONG : RULE
    }"/>`;
  }
  return out;
}

/** The in-point wedge that opens every page header on the site. */
function inPointSvg(): string {
  return `<path d="M0 0 L11 7 L0 14 Z" fill="${ACCENT}"/>`;
}

function ogSvg(title: string, subtitle: string): string {
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="630" fill="${PAPER}"/>

    <!-- brand row -->
    <g transform="translate(80, 68)">
      ${markSvg(56, 13)}
      <text x="74" y="38" font-family="${FONT}" font-size="30" font-weight="700" fill="${INK}" letter-spacing="-0.8">FramePilot</text>
    </g>

    <!-- in point + timecode eyebrow -->
    <g transform="translate(80, 206)">
      ${inPointSvg()}
      <text x="26" y="12" font-family="${MONO}" font-size="17" letter-spacing="3.4" fill="${ACCENT}">00:00</text>
      <text x="120" y="12" font-family="${MONO}" font-size="17" letter-spacing="3.4" fill="${INK_FAINT}">AI-NATIVE DESKTOP EDITOR</text>
    </g>

    <text x="78" y="322" font-family="${FONT}" font-size="76" font-weight="700" fill="${INK}" letter-spacing="-3.4">${escapeXml(title)}</text>
    <text x="80" y="392" font-family="${FONT}" font-size="26" font-weight="400" fill="${INK_SOFT}">${escapeXml(subtitle)}</text>

    <!-- one clip on a track: the download -->
    <g transform="translate(80, 452)">
      <rect x="-6" y="-6" width="452" height="64" rx="4" fill="${RULE}" fill-opacity="0.45"/>
      <rect width="440" height="52" rx="5" fill="${ACCENT}"/>
      <text x="220" y="34" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="600" fill="#ffffff">Download for macOS · Windows · Linux</text>
      <text x="474" y="34" font-family="${MONO}" font-size="19" letter-spacing="2" fill="${INK_FAINT}">framepilot.app</text>
    </g>

    <!-- the ruler runs out the bottom, with the playhead parked on it -->
    <g transform="translate(0, 574)">
      <rect x="0" y="0" width="1200" height="1" fill="${RULE}"/>
      <g transform="translate(0, 1)">${ticksSvg(1200)}</g>
    </g>
    <g>
      <rect x="838" y="562" width="2" height="68" fill="${ACCENT}"/>
      <rect x="832" y="562" width="14" height="14" rx="2" fill="${ACCENT}"/>
    </g>
  </svg>`;
}

function iconSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${markSvg(
    size,
    size * 0.22,
  )}</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string);
}

function render(svg: string, width: number): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true },
  });
  return Buffer.from(r.render().asPng());
}

/** Wrap a single PNG in a minimal ICO container (PNG-embedded ICO). */
function pngToIco(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8); // size
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, png]);
}

// ---- Emit assets ----
writeFileSync(
  resolve(PUBLIC, 'og.png'),
  render(
    ogSvg(
      'Your timeline. With an agent.',
      'A desktop video editor where the agent works on the same timeline you do.',
    ),
    1200,
  ),
);
writeFileSync(resolve(PUBLIC, 'icon-192.png'), render(iconSvg(192), 192));
writeFileSync(resolve(PUBLIC, 'icon-512.png'), render(iconSvg(512), 512));
writeFileSync(resolve(PUBLIC, 'apple-touch-icon.png'), render(iconSvg(180), 180));
writeFileSync(resolve(PUBLIC, 'icon.svg'), iconSvg(64), 'utf8');
writeFileSync(resolve(PUBLIC, 'favicon.ico'), pngToIco(render(iconSvg(32), 32), 32));

console.log('[generate-og] Wrote og.png, icons, favicon.ico → public/');
