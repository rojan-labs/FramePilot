/**
 * Generates all brand raster assets for the site into `public/`:
 *   - og.png            1200×630 Open Graph / Twitter card
 *   - icon-192.png      PWA icon
 *   - icon-512.png      PWA icon
 *   - apple-touch-icon.png  180×180
 *   - icon.svg          scalable favicon
 *   - favicon.ico       32×32 (PNG-embedded ICO)
 *
 * FramePilot brand: cool navy field, cool paper-white type, warm orange accent
 * from the logo. The mark itself is the real logo (public/logo.png, sourced from
 * ui_revamp/logo/framepilot logo-clean.png), embedded.
 * Uses @resvg/resvg-js with system fonts (works offline).
 * Run manually with `pnpm generate:og` whenever the brand changes.
 */
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
mkdirSync(PUBLIC, { recursive: true });

const BG = '#0d0e15';
const PAPER = '#eceef6';
const ACCENT = '#e5670a';
const FONT = 'Helvetica, Arial, sans-serif';

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

/** A row of timeline ruler ticks. */
function ticksSvg(width: number, step = 26, height = 14): string {
  let out = '';
  for (let x = 0; x <= width; x += step) {
    const tall = x % (step * 5) === 0;
    out += `<rect x="${x}" y="${tall ? 0 : 5}" width="1.5" height="${tall ? height : height - 5}" fill="${PAPER}" opacity="${tall ? 0.28 : 0.14}"/>`;
  }
  return out;
}

function ogSvg(title: string, subtitle: string): string {
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="glow" cx="50%" cy="0%" r="75%">
        <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.2"/>
        <stop offset="70%" stop-color="${ACCENT}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${PAPER}"/>
        <stop offset="100%" stop-color="${PAPER}" stop-opacity="0.78"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="${BG}"/>
    <rect width="1200" height="630" fill="url(#glow)"/>

    <!-- brand row -->
    <g transform="translate(80, 72)">
      ${markSvg(64, 14)}
      <text x="84" y="43" font-family="${FONT}" font-size="34" font-weight="700" fill="${PAPER}">FramePilot</text>
    </g>

    <!-- timecode eyebrow -->
    <g transform="translate(80, 208)">
      <circle cx="6" cy="-6" r="6" fill="${ACCENT}"/>
      <text x="24" y="0" font-family="Courier, monospace" font-size="20" letter-spacing="4" fill="${PAPER}" fill-opacity="0.5">REC · AI VIDEO EDITOR FOR CREATORS</text>
    </g>

    <text x="80" y="324" font-family="${FONT}" font-size="55" font-weight="700" fill="url(#ink)" letter-spacing="-1.5">${escapeXml(title)}</text>
    <text x="82" y="390" font-family="${FONT}" font-size="28" font-weight="400" fill="${PAPER}" fill-opacity="0.62">${escapeXml(subtitle)}</text>

    <!-- CTA -->
    <g transform="translate(80, 484)">
      <rect width="380" height="58" rx="12" fill="${ACCENT}"/>
      <text x="190" y="37" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="600" fill="#ffffff">Download for macOS · Win · Linux</text>
      <text x="412" y="37" font-family="${FONT}" font-size="22" fill="${PAPER}" fill-opacity="0.45">framepilot.app</text>
    </g>

    <!-- timeline ruler with ember playhead running out the bottom -->
    <g transform="translate(0, 588)">${ticksSvg(1200)}</g>
    <rect x="0" y="628" width="1200" height="2" fill="${ACCENT}" opacity="0.6"/>
    <g>
      <rect x="838" y="580" width="3" height="50" fill="${ACCENT}"/>
      <path d="M828 574h23l-11.5 12Z" fill="${ACCENT}"/>
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
      'Edit like a pro. Without being one.',
      'Drop in raw footage — get a finished cut. You control every frame.',
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
