/**
 * Stand-in tiles for the editors the intro throws away.
 *
 * The repository has no licence to ship Adobe, Blackmagic, Apple, or ByteDance
 * artwork, so no real mark is copied (ADR 0172). Each tool is drawn as the kind
 * of tile a visitor already associates with it — Adobe's two-letter squares,
 * Resolve's coloured orbit, Final Cut's clapper, CapCut's bracket cut, iMovie's
 * star — in that tool's colours, large enough to be read from the corner bin.
 * Naming a competitor is fair; copying its logo is not. If permission ever
 * arrives, only the glyphs in this file change.
 */

export interface ToolTile {
  id: string;
  name: string;
  /** Label used where a name has to fit in one short line. */
  short: string;
  /** Tile fill. */
  ground: string;
  /** Glyph colour. */
  ink: string;
  /** Which stand-in glyph to draw. */
  glyph: 'letters' | 'orbit' | 'clapper' | 'bracket' | 'star';
  /** For the `letters` glyph: two letters in the shorthand editors already use. */
  initials?: string;
  /** True for FramePilot, which is the survivor and uses the real logo. */
  survivor?: boolean;
}

export const COMPETITOR_TOOLS: ToolTile[] = [
  { id: 'premiere', name: 'Premiere Pro', short: 'Premiere', glyph: 'letters', initials: 'Pr', ground: '#2b0a4f', ink: '#d0a8ff' },
  { id: 'after-effects', name: 'After Effects', short: 'After FX', glyph: 'letters', initials: 'Ae', ground: '#1d0836', ink: '#cfa0ff' },
  { id: 'resolve', name: 'DaVinci Resolve', short: 'Resolve', glyph: 'orbit', ground: '#1f2329', ink: '#f2a03c' },
  { id: 'final-cut', name: 'Final Cut Pro', short: 'Final Cut', glyph: 'clapper', ground: '#16161a', ink: '#8fd0ff' },
  { id: 'capcut', name: 'CapCut', short: 'CapCut', glyph: 'bracket', ground: '#0d0d10', ink: '#ffffff' },
  { id: 'imovie', name: 'iMovie', short: 'iMovie', glyph: 'star', ground: '#5b3fd6', ink: '#ffffff' },
];

export const FRAMEPILOT_TILE: ToolTile = {
  id: 'framepilot',
  name: 'FramePilot',
  short: 'FramePilot',
  glyph: 'letters',
  initials: 'Fp',
  ground: '#17140f',
  ink: '#f26522',
  survivor: true,
};

/** The names of everything the intro retires, in the order it is thrown out. */
export const RETIRED_NAMES = COMPETITOR_TOOLS.map((tool) => tool.name);

function Glyph({ tile }: { tile: ToolTile }) {
  switch (tile.glyph) {
    case 'orbit':
      // Three coloured arcs around a core: the shape people know Resolve by.
      return (
        <g fill="none" strokeWidth="5" strokeLinecap="round">
          <path d="M24 9.5 A14.5 14.5 0 0 1 36.6 31.2" stroke="#f2a03c" />
          <path d="M36.6 31.2 A14.5 14.5 0 0 1 11.4 31.2" stroke="#4fb3ff" />
          <path d="M11.4 31.2 A14.5 14.5 0 0 1 24 9.5" stroke="#ff5d73" />
          <circle cx="24" cy="24" r="5.2" fill="#e9e9ee" />
        </g>
      );
    case 'clapper':
      return (
        <g fill={tile.ink}>
          <path d="M11 20 H37 V35.5 A2.5 2.5 0 0 1 34.5 38 H13.5 A2.5 2.5 0 0 1 11 35.5 Z" />
          <path d="M11.4 18.2 L13 11.8 L37.2 15.4 L36.2 20 Z" opacity="0.72" />
          <rect x="11" y="24.5" width="26" height="2" fill={tile.ground} opacity="0.55" />
        </g>
      );
    case 'bracket':
      // A clip between two cut marks.
      return (
        <g fill="none" stroke={tile.ink} strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 11 H11 V37 H18" />
          <path d="M30 11 H37 V37 H30" />
          <path d="M18.5 24 H29.5" strokeWidth="5" />
        </g>
      );
    case 'star':
      return (
        <path
          fill={tile.ink}
          d="M24 9.5 L28.3 19.4 L39 20.5 L31 27.7 L33.3 38.3 L24 32.8 L14.7 38.3 L17 27.7 L9 20.5 L19.7 19.4 Z"
        />
      );
    case 'letters':
    default:
      return (
        <text
          x="24"
          y="25"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="var(--font-display), system-ui, sans-serif"
          fontSize="20"
          fontWeight="700"
          letterSpacing="-0.6"
          fill={tile.ink}
        >
          {tile.initials}
        </text>
      );
  }
}

export function ToolGlyph({ tile, size = 46 }: { tile: ToolTile; size?: number | string }) {
  if (tile.survivor) {
    return (
      <img
        src="/logo.png"
        alt=""
        aria-hidden
        className="block rounded-[22%]"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden
      focusable="false"
      style={{ display: 'block', width: size, height: size }}
    >
      <rect width="48" height="48" rx="11" fill={tile.ground} />
      <rect
        x="0.6"
        y="0.6"
        width="46.8"
        height="46.8"
        rx="10.4"
        fill="none"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1.2"
      />
      <Glyph tile={tile} />
    </svg>
  );
}
