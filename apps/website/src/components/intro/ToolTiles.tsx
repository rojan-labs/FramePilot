/**
 * Stand-in tiles for the editors the intro throws away.
 *
 * The repository has no licence to ship Adobe, Blackmagic, Apple, or ByteDance
 * artwork, so no real mark is drawn (ADR 0172). Each tool is a rounded tile in
 * a colour that reads as that tool, carrying its two-letter initials, with the
 * tool's name printed underneath. Naming a competitor is fair; copying its logo
 * is not. If permission ever arrives, only the glyphs in this file change.
 */

export interface ToolTile {
  id: string;
  name: string;
  /** Two letters, in the same shorthand editors already use for these apps. */
  initials: string;
  /** Tile fill. */
  ground: string;
  /** Initials colour. */
  ink: string;
  /** True for FramePilot, which is the survivor and uses the real logo. */
  survivor?: boolean;
}

export const COMPETITOR_TOOLS: ToolTile[] = [
  { id: 'premiere', name: 'Premiere Pro', initials: 'Pr', ground: '#2a0a4a', ink: '#c7a4ff' },
  { id: 'after-effects', name: 'After Effects', initials: 'Ae', ground: '#1c0733', ink: '#cfa6ff' },
  { id: 'resolve', name: 'DaVinci Resolve', initials: 'Dv', ground: '#23272c', ink: '#f2a03c' },
  { id: 'final-cut', name: 'Final Cut Pro', initials: 'Fc', ground: '#1c1c1e', ink: '#8fd0ff' },
  { id: 'capcut', name: 'CapCut', initials: 'Cc', ground: '#101014', ink: '#4fdae8' },
  { id: 'imovie', name: 'iMovie', initials: 'iM', ground: '#e9e9ee', ink: '#2f72d8' },
];

export const FRAMEPILOT_TILE: ToolTile = {
  id: 'framepilot',
  name: 'FramePilot',
  initials: 'Fp',
  ground: '#17140f',
  ink: '#f26522',
  survivor: true,
};

/**
 * The row as it first assembles, with FramePilot sitting middle-right so the
 * playhead reaches it after most of the field has already gone.
 */
export const TRACK_TILES: ToolTile[] = [
  COMPETITOR_TOOLS[0],
  COMPETITOR_TOOLS[1],
  COMPETITOR_TOOLS[2],
  COMPETITOR_TOOLS[3],
  FRAMEPILOT_TILE,
  COMPETITOR_TOOLS[4],
  COMPETITOR_TOOLS[5],
];

/** The names of everything the intro retires, in the order it is cut. */
export const RETIRED_NAMES = COMPETITOR_TOOLS.map((tool) => tool.name);

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
        stroke="rgba(0,0,0,0.22)"
        strokeWidth="1.2"
      />
      <text
        x="24"
        y="25"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--font-display), system-ui, sans-serif"
        fontSize="19"
        fontWeight="700"
        letterSpacing="-0.5"
        fill={tile.ink}
      >
        {tile.initials}
      </text>
    </svg>
  );
}
