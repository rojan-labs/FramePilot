/**
 * The Shapes sub-tab of Elements (plan/elements EL4a, EL5): the catalogue's presets and the
 * Lucide icons, browsed by category chip and search, previewed in the colour the colour row
 * picks. A click (or Enter) adds the shape at the playhead as one undoable edit and selects it for
 * the Inspector; a drag drops it on a timeline lane.
 *
 * The tiles are drawn here, in SVG, at tile size only. The monitor and the export never use this
 * drawing: the engine rasterises every shape (ADR 0190), so a tile is a picture of the preset,
 * deliberately not pinned to the engine's pixels.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  searchShapes,
  type ShapeCategory,
  type ShapeDescriptor,
  type ShapePreset,
  type ShapeSearchHit,
} from '@framepilot/timeline-schema';
import { useViewPreference } from '../../editor/useViewPreference.js';
import { recolourPreset } from '../../editor/shape-builders.js';
import { writeElementDrag } from './element-dnd.js';
import { boxTileOutline, tileBoxFor } from './shape-tile-outline.js';
import { useShapeIconPaths } from './useShapeIconPaths.js';
import { useTileGrid } from './useTileGrid.js';

export interface ShapesBrowserProps {
  /**
   * Add the preset (or `icon/<name>`) at the playhead in `colour` (`#rrggbb`, or `null` for the
   * preset's own); returns the sentence to show when it cannot, else `null`.
   */
  readonly onAddShape: (presetId: string, colour: string | null) => string | null;
  /** The search to start with, so a sub-tab round trip keeps it (02 §2: kept for the session). */
  readonly initialQuery?: string;
  readonly onQueryChange?: (query: string) => void;
  /** Where the grid was scrolled to, so a round trip comes back to the same tiles. */
  readonly initialScrollTop?: number;
  readonly onScrollTopChange?: (scrollTop: number) => void;
}

/** The SVG colour for a `#rrggbb[aa]` value, or `none`. */
function paint(colour: string | null): { readonly colour: string; readonly opacity: number } {
  if (colour === null) return { colour: 'none', opacity: 1 };
  const alpha = colour.length === 9 ? parseInt(colour.slice(7, 9), 16) / 255 : 1;
  return { colour: colour.slice(0, 7), opacity: alpha };
}

const TILE = 64;

/** A segment shape's tile: its line (bowed when it curves) and its caps. */
function SegmentTile({
  shape,
  preset,
  stroke,
  strokeWidth,
  common,
}: {
  readonly shape: ShapeDescriptor;
  readonly preset: ShapePreset;
  readonly stroke: { readonly colour: string; readonly opacity: number };
  readonly strokeWidth: number;
  readonly common: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const flat = shape.frame === 'segment' && shape.defaults.y1 === shape.defaults.y2;
  const [x1, y1, x2, y2] = flat ? [10, 32, 54, 32] : [14, 48, 50, 14];
  const bend =
    (preset.knobs?.curvature ??
      shape.knobs.find((knob) => knob.name === 'curvature')?.default ??
      0) / 100;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const [nx, ny] = [-(y2 - y1) / length, (x2 - x1) / length];
  const [cx, cy] = [
    (x1 + x2) / 2 + (nx * bend * length) / 2,
    (y1 + y2) / 2 + (ny * bend * length) / 2,
  ];
  const cap = (kind: string | undefined, tip: readonly [number, number]): JSX.Element | null => {
    const [dx, dy] = [tip[0] - cx, tip[1] - cy];
    const unit = Math.hypot(dx, dy) || 1;
    const [ux, uy] = [dx / unit, dy / unit];
    const fill = { fill: stroke.colour, fillOpacity: stroke.opacity };
    if (kind === 'arrow') {
      const head = strokeWidth * 3.2;
      const [bx, by] = [tip[0] - ux * head, tip[1] - uy * head];
      const [px, py] = [-uy * head * 0.5, ux * head * 0.5];
      return (
        <polygon
          points={`${tip[0]},${tip[1]} ${bx + px},${by + py} ${bx - px},${by - py}`}
          {...fill}
        />
      );
    }
    if (kind === 'dot') return <circle cx={tip[0]} cy={tip[1]} r={strokeWidth} {...fill} />;
    if (kind === 'bar') {
      const [px, py] = [-uy * strokeWidth * 2, ux * strokeWidth * 2];
      return (
        <line
          x1={tip[0] + px}
          y1={tip[1] + py}
          x2={tip[0] - px}
          y2={tip[1] - py}
          stroke={stroke.colour}
          strokeOpacity={stroke.opacity}
          strokeWidth={strokeWidth}
        />
      );
    }
    return null;
  };
  return (
    <>
      <path d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`} {...common} fill="none" />
      {cap(preset.startCap, [x1, y1])}
      {cap(preset.endCap, [x2, y2])}
    </>
  );
}

/** A tile-sized picture of a preset. UI only: see the module note. */
export function ShapeTile({
  shape,
  preset,
  iconPaths = null,
  className = 'shape-tile',
}: {
  readonly shape: ShapeDescriptor;
  readonly preset: ShapePreset;
  readonly iconPaths?: ReadonlyMap<string, string> | null;
  readonly className?: string;
}): JSX.Element {
  const fill = paint(preset.fill);
  const stroke = paint(preset.stroke);
  const strokeWidth = Math.max(1.5, (preset.strokeWidth / 100) * TILE * 3);
  const dash =
    preset.strokeStyle === 'dashed'
      ? `${strokeWidth * 3} ${strokeWidth * 2}`
      : preset.strokeStyle === 'dotted'
        ? `0 ${strokeWidth * 2}`
        : undefined;
  const common = {
    fill: fill.colour,
    fillOpacity: fill.opacity,
    stroke: stroke.colour,
    strokeOpacity: stroke.opacity,
    strokeWidth,
    strokeDasharray: dash,
    strokeLinecap:
      preset.strokeStyle === 'dotted' || shape.geometry?.roundCaps === true
        ? ('round' as const)
        : ('butt' as const),
    strokeLinejoin: 'round' as const,
  };
  let body: JSX.Element | null;
  if (shape.frame === 'segment') {
    body = (
      <SegmentTile
        shape={shape}
        preset={preset}
        stroke={stroke}
        strokeWidth={strokeWidth}
        common={common}
      />
    );
  } else {
    const outline = boxTileOutline(shape, preset, tileBoxFor(shape, TILE), iconPaths);
    body =
      outline === null ? null : (
        <path
          d={outline.d}
          {...common}
          fill={outline.fills ? fill.colour : 'none'}
          fillRule={outline.fillRule}
        />
      );
  }
  return (
    <svg className={className} viewBox={`0 0 ${TILE} ${TILE}`} aria-hidden="true">
      {body}
      {preset.label !== undefined && (
        <text
          x={TILE / 2}
          y={TILE / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={TILE * 0.3}
          fontWeight={700}
          fill={preset.labelColor ?? '#FFFFFF'}
        >
          {preset.label}
        </text>
      )}
    </svg>
  );
}

type Chip = 'all' | ShapeCategory | 'icons';

/** The chips, in the order 02 §2.3 lists them. */
const CHIPS: readonly { readonly id: Chip; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'basic', label: 'Basic' },
  { id: 'arrows', label: 'Arrows' },
  { id: 'lines', label: 'Lines' },
  { id: 'callouts', label: 'Callouts' },
  { id: 'highlights', label: 'Highlights' },
  { id: 'stars', label: 'Stars & badges' },
  { id: 'frames', label: 'Frames' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'numbers', label: 'Numbers' },
  { id: 'icons', label: 'Icons' },
];
const CHIP_IDS: ReadonlySet<string> = new Set(CHIPS.map((chip) => chip.id));

/** The colours the row offers before the editor has picked any (the catalogue palette). */
const DEFAULT_COLOURS = ['#FFD400', '#FF3B30', '#FFFFFF', '#0A84FF', '#34C759', '#111111'];
const SWATCHES = 6;
const HEX = /^#[0-9A-F]{6}$/;
/** Icon tiles shown at once, and how many more "Show more" adds: 1,700 SVGs at once would stall. */
const ICON_PAGE = 120;

type Entry = ShapeSearchHit;

/** The chip's tiles for `query`: the shared ranking the agent's search_elements uses too. */
function visibleEntries(chip: Chip, query: string): readonly Entry[] {
  return searchShapes(query, chip === 'all' ? undefined : chip).hits;
}

const coerceChip = (raw: unknown): Chip | undefined =>
  typeof raw === 'string' && CHIP_IDS.has(raw) ? (raw as Chip) : undefined;
const coerceColour = (raw: unknown): string | null | undefined =>
  raw === null ? null : typeof raw === 'string' && HEX.test(raw) ? raw : undefined;
const coerceColours = (raw: unknown): readonly string[] | undefined =>
  Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string' && HEX.test(value))
    : undefined;

export function ShapesBrowser({
  onAddShape,
  initialQuery = '',
  onQueryChange,
  initialScrollTop = 0,
  onScrollTopChange,
}: ShapesBrowserProps): JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [query, setQueryState] = useState(initialQuery);
  const setQuery = (next: string): void => {
    setQueryState(next);
    onQueryChange?.(next);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  // Back to where the grid was, before the first paint.
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = initialScrollTop;
    // Once, on mount: afterwards the grid's own scroll is the truth.
  }, []);
  const [iconLimit, setIconLimit] = useState(ICON_PAGE);
  // View state, never project state: the chip, the chosen colour and the recent colours are
  // how this person browses, and change no frame of the output.
  const [chip, setChip] = useViewPreference<Chip>('shapesChip', 'all', coerceChip);
  const [colour, setColour] = useViewPreference<string | null>('shapesColour', null, coerceColour);
  const [recent, setRecent] = useViewPreference<readonly string[]>(
    'shapesRecentColours',
    [],
    coerceColours,
  );
  const iconPaths = useShapeIconPaths();
  const searchRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => visibleEntries(chip, query), [chip, query]);
  const firstIcon = matches.findIndex(({ shape }) => shape.id.startsWith('icon/'));
  const shown = firstIcon < 0 ? matches : matches.slice(0, Math.max(firstIcon, 0) + iconLimit);
  const hidden = matches.length - shown.length;
  const { gridRef, focusIndex, setActive, onGridKey } = useTileGrid(
    shown.length,
    '.shapes-grid-tile',
  );
  const swatches = [...recent, ...DEFAULT_COLOURS.filter((c) => !recent.includes(c))].slice(
    0,
    SWATCHES,
  );

  const choose = (next: string | null): void => {
    setColour(next);
    if (next !== null) setRecent([next, ...recent.filter((c) => c !== next)].slice(0, SWATCHES));
  };
  const add = (entry: Entry): void => setRefusal(onAddShape(entry.preset.id, colour));
  return (
    <div
      className="shapes-browser"
      onKeyDown={(event) => {
        // "/" jumps to the search while focus is in the panel, never from the timeline.
        if (event.key === '/' && event.target !== searchRef.current) {
          event.preventDefault();
          searchRef.current?.focus();
        }
      }}
    >
      <input
        ref={searchRef}
        type="search"
        className="elements-search"
        data-ui="input"
        data-size="sm"
        aria-label="Search shapes"
        placeholder="Search shapes and icons"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setIconLimit(ICON_PAGE);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation();
            setQuery('');
          }
        }}
      />
      <div className="shapes-chips" role="group" aria-label="Shape categories">
        {CHIPS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="shapes-chip"
            aria-pressed={chip === id}
            onClick={() => {
              setChip(id);
              setActive(0);
              setIconLimit(ICON_PAGE);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="shapes-colours" role="group" aria-label="Shape colour">
        <button
          type="button"
          className="shapes-swatch is-preset"
          aria-pressed={colour === null}
          aria-label="Preset colours"
          title="Each shape in its own colours"
          onClick={() => choose(null)}
        />
        {swatches.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="shapes-swatch"
            style={{ background: swatch }}
            aria-pressed={colour === swatch}
            aria-label={`Colour ${swatch}`}
            title={swatch}
            onClick={() => choose(swatch)}
          />
        ))}
        <input
          type="color"
          className="shapes-swatch-picker"
          aria-label="Custom colour"
          value={(colour ?? '#FFD400').toLowerCase()}
          onChange={(event) => choose(event.target.value.toUpperCase())}
        />
      </div>
      <p className="sr-only" aria-live="polite">
        {`${String(matches.length)} shapes`}
      </p>
      {/* Only the grid scrolls: the search, the chips and the colours stay put, as they do on
          Stickers and Photos. */}
      <div
        ref={scrollRef}
        className="shapes-scroll"
        onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
      >
        {shown.length === 0 ? (
          <p className="stock-note">
            Nothing matched “{query.trim()}”. Try a simpler word — “arrow”, “box”, “star”.
          </p>
        ) : (
          <ul ref={gridRef} className="shapes-grid" aria-label="Shapes" onKeyDown={onGridKey}>
            {shown.map((entry, index) => {
              const style = recolourPreset(entry.preset, colour);
              return (
                <li key={entry.preset.id}>
                  <button
                    type="button"
                    className="shapes-grid-tile"
                    tabIndex={index === focusIndex ? 0 : -1}
                    aria-label={`Add ${entry.preset.name}`}
                    title={`Add ${entry.preset.name} at the playhead, or drag it onto a lane or the monitor`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy';
                      writeElementDrag(event.dataTransfer, {
                        kind: 'shape',
                        presetId: entry.preset.id,
                        colour,
                      });
                    }}
                    onFocus={() => setActive(index)}
                    onClick={() => add(entry)}
                  >
                    <ShapeTile shape={entry.shape} preset={style} iconPaths={iconPaths} />
                    <span className="shapes-grid-name">{entry.preset.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 && (
          <button
            type="button"
            className="shapes-more"
            onClick={() => setIconLimit((limit) => limit + ICON_PAGE * 2)}
          >
            {`Show more icons (${hidden.toLocaleString()} left)`}
          </button>
        )}
      </div>
      {/* Mounted empty, so the region is there before it has anything to say. */}
      <p className="stock-note live-slot" role="status">
        {refusal ?? ''}
      </p>
    </div>
  );
}
