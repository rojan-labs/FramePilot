/**
 * The Shapes sub-tab of Elements (plan/elements EL4a): one tile per preset; a click adds the
 * shape at the playhead as one undoable edit and selects it for the Inspector.
 *
 * The tiles are drawn here, in SVG, at tile size only. The monitor and the export never use this
 * drawing: the engine rasterises every shape (ADR 0190), so a tile is a picture of the preset,
 * deliberately not pinned to the engine's pixels.
 */
import { useState } from 'react';
import { SHAPE_PRESETS, type ShapeDescriptor, type ShapePreset } from '@framepilot/timeline-schema';

export interface ShapesBrowserProps {
  /** Add the preset at the playhead; returns the sentence to show when it cannot, else `null`. */
  readonly onAddShape: (presetId: string) => string | null;
}

/** The SVG colour for a `#rrggbb[aa]` value, or `none`. */
function paint(colour: string | null): { readonly colour: string; readonly opacity: number } {
  if (colour === null) return { colour: 'none', opacity: 1 };
  const alpha = colour.length === 9 ? parseInt(colour.slice(7, 9), 16) / 255 : 1;
  return { colour: colour.slice(0, 7), opacity: alpha };
}

const TILE = 64;

/** A tile-sized picture of a preset. UI only: see the module note. */
export function ShapeTile({
  shape,
  preset,
}: {
  readonly shape: ShapeDescriptor;
  readonly preset: ShapePreset;
}): JSX.Element {
  const fill = paint(preset.fill);
  const stroke = paint(preset.stroke);
  const strokeWidth = Math.max(2, (preset.strokeWidth / 100) * TILE * 4);
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
    strokeLinecap: preset.strokeStyle === 'dotted' ? ('round' as const) : ('butt' as const),
  };
  let body: JSX.Element;
  if (shape.frame === 'segment') {
    const arrow = preset.endCap === 'arrow';
    const [x1, y1, x2, y2] = shape.id === 'underline-marker' ? [10, 44, 54, 44] : [14, 14, 48, 48];
    body = (
      <>
        <line x1={x1} y1={y1} x2={arrow ? x2 - 6 : x2} y2={arrow ? y2 - 6 : y2} {...common} />
        {arrow && (
          <polygon
            points={`${x2},${y2} ${x2 - 14},${y2 - 4} ${x2 - 4},${y2 - 14}`}
            fill={stroke.colour}
            fillOpacity={stroke.opacity}
          />
        )}
      </>
    );
  } else if (shape.generator === 'ellipse') {
    body = <ellipse cx={32} cy={32} rx={24} ry={16} {...common} />;
  } else {
    const height = shape.defaults.height >= shape.defaults.width / 3 ? 30 : 12;
    const corner = preset.knobs?.cornerRadius ?? shape.knobs[0]?.default ?? 0;
    body = (
      <rect
        x={8}
        y={32 - height / 2}
        width={48}
        height={height}
        rx={(Math.min(48, height) * corner) / 100}
        {...common}
      />
    );
  }
  return (
    <svg className="shape-tile" viewBox={`0 0 ${TILE} ${TILE}`} aria-hidden="true">
      {body}
    </svg>
  );
}

export function ShapesBrowser({ onAddShape }: ShapesBrowserProps): JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <div className="shapes-browser">
      <ul className="shapes-grid" aria-label="Shapes">
        {SHAPE_PRESETS.map(({ shape, preset }) => (
          <li key={preset.id}>
            <button
              type="button"
              className="shapes-grid-tile"
              aria-label={`Add ${preset.name}`}
              title={`Add ${preset.name} at the playhead`}
              onClick={() => setRefusal(onAddShape(preset.id))}
            >
              <ShapeTile shape={shape} preset={preset} />
              <span className="shapes-grid-name">{preset.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {refusal !== null && (
        <p className="stock-note" role="status">
          {refusal}
        </p>
      )}
    </div>
  );
}
