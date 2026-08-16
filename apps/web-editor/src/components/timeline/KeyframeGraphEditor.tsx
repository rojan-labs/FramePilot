/**
 * The interpolation menu and the curve editor for one keyframe
 * (revamp Phase 7, F9 — schema v14, ADR 0089).
 *
 * ## Progressive disclosure, as the design direction requires
 *
 * The **menu** is the everyday control: seven named curves, one click. The **graph**
 * is behind a disclosure and only appears for `bezier`, because dragging control
 * points is a colourist's tool and a beginner should never meet it. That split is
 * §3's "a beginner never sees them; a colorist finds them in one click".
 *
 * ## The curve drawn is the curve rendered
 *
 * The preview path plots `segmentProgress` — the *same* function
 * `evaluateKeyframes` uses, which is the same arithmetic the Python export mirrors
 * (parity-tested to 1e-12). It is not a CSS approximation of the curve, and it is not
 * a separate plotting routine that could drift from the engine. What you drag is what
 * renders.
 *
 * ## Overshoot is drawn, not clipped
 *
 * The plot's y-range expands to fit the curve, so an overshoot to 1.4 is visible as
 * an overshoot rather than a line pinned to the top of the box. Drawing a clipped
 * curve would hide the exact behaviour the user reached for a custom curve to get.
 */
import { useRef, useState } from 'react';
import type { Keyframe } from '@framepilot/timeline-schema';
import { type Easing, segmentProgress } from '@framepilot/editor-core';
import { EASINGS } from '../../editor/patch-builders.js';
import { LabeledSelect } from '../inspector/LabeledSelect.js';

/** Straight handles — the identity curve, and where a fresh bezier starts. */
export const STRAIGHT_HANDLES = {
  out: [1 / 3, 1 / 3] as [number, number],
  in: [2 / 3, 2 / 3] as [number, number],
};

/** Plot box in SVG user units. Square, because the curve's axes are both 0..1. */
const PLOT = 100;
/** Padding around the plot, so a handle at y=0 or y=1 is still grabbable. */
const PAD = 14;
/** How many samples to draw the curve with. Enough to look smooth at this size. */
const SAMPLES = 48;

export interface KeyframeGraphEditorProps {
  /** The keyframe being shaped — its `out` handle starts the segment. */
  readonly keyframe: Keyframe;
  /** The next keyframe — its `in` handle ends the segment. `null` when this is last. */
  readonly next: Keyframe | null;
  readonly onEasingChange: (easing: Easing) => void;
  /** Commit both control points. `null` resets to the default smoothstep. */
  readonly onHandlesChange: (
    handles: { out: [number, number]; in: [number, number] } | null,
  ) => void;
}

/** Which handle a drag is moving. */
type Grabbed = 'out' | 'in' | null;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * The curve's sample points, plus the y-range needed to show them all.
 *
 * Exported for the tests: "does the plot include the overshoot" is a claim about
 * numbers, and asserting it against an SVG path string would be asserting the
 * formatting rather than the behaviour.
 */
export function curveSamples(
  keyframe: Keyframe,
  next: Keyframe | null,
): {
  readonly points: readonly (readonly [number, number])[];
  readonly min: number;
  readonly max: number;
} {
  // With no following keyframe there is no segment; the identity is the honest
  // thing to draw rather than a curve into nothing.
  const right = next ?? { ...keyframe, time: keyframe.time + 1 };
  const points: [number, number][] = [];
  let min = 0;
  let max = 1;
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = i / SAMPLES;
    const y = segmentProgress(keyframe, right, t);
    if (y < min) min = y;
    if (y > max) max = y;
    points.push([t, y]);
  }
  return { points, min, max };
}

export function KeyframeGraphEditor({
  keyframe,
  next,
  onEasingChange,
  onHandlesChange,
}: KeyframeGraphEditorProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [grabbed, setGrabbed] = useState<Grabbed>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const handles = {
    out: keyframe.handles?.out ?? STRAIGHT_HANDLES.out,
    in: next?.handles?.in ?? STRAIGHT_HANDLES.in,
  };
  const isBezier = keyframe.easing === 'bezier';
  const { points, min, max } = curveSamples(keyframe, next);

  /** Curve y → SVG y, with the box expanded to fit overshoot/anticipation. */
  const span = max - min;
  const toSvgY = (y: number): number => PAD + (1 - (y - min) / span) * PLOT;
  const toSvgX = (x: number): number => PAD + x * PLOT;
  /** SVG y → curve y, the inverse, for a drag. */
  const fromSvgY = (svgY: number): number => min + (1 - (svgY - PAD) / PLOT) * span;

  const path = points
    .map(
      ([x, y], index) =>
        `${index === 0 ? 'M' : 'L'}${toSvgX(x).toFixed(2)},${toSvgY(y).toFixed(2)}`,
    )
    .join(' ');

  /** Move the grabbed handle to a pointer position, in curve coordinates. */
  const moveHandle = (which: 'out' | 'in', clientX: number, clientY: number): void => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    // The SVG scales to its box, so pointer px → user units needs the ratio.
    const scaleX = (PLOT + PAD * 2) / rect.width;
    const scaleY = (PLOT + PAD * 2) / rect.height;
    const userX = (clientX - rect.left) * scaleX;
    const userY = (clientY - rect.top) * scaleY;
    // x is clamped (a non-monotonic curve would run the property backwards in
    // time); y is not (overshoot and anticipation are the point). ADR 0089.
    const nextHandle: [number, number] = [clamp01((userX - PAD) / PLOT), fromSvgY(userY)];
    onHandlesChange(
      which === 'out'
        ? { out: nextHandle, in: [...handles.in] as [number, number] }
        : { out: [...handles.out] as [number, number], in: nextHandle },
    );
  };

  return (
    <div className="keyframe-curve">
      <LabeledSelect
        caption="Interpolation"
        label="keyframe interpolation"
        value={keyframe.easing}
        options={EASINGS}
        onChange={(value) => onEasingChange(value as Easing)}
      />

      {/*
        The graph appears only for `bezier`. Offering it for `ease-in` would be a
        control that stores handles the engine then ignores — see the note on
        `setKeyframeHandlesPatch`.
      */}
      {isBezier && (
        <>
          <button
            type="button"
            className="keyframe-curve-toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? 'Hide curve' : 'Edit curve'}
          </button>

          {open && (
            <div className="keyframe-curve-panel">
              <svg
                ref={svgRef}
                className="keyframe-curve-plot"
                viewBox={`0 0 ${PLOT + PAD * 2} ${PLOT + PAD * 2}`}
                role="img"
                aria-label={`${keyframe.property} keyframe curve`}
                onPointerMove={(event) => {
                  if (grabbed === null) return;
                  moveHandle(grabbed, event.clientX, event.clientY);
                }}
                onPointerUp={() => setGrabbed(null)}
                onPointerLeave={() => setGrabbed(null)}
              >
                {/* The unit box, so the curve has something to be read against. */}
                <rect
                  x={PAD}
                  y={toSvgY(1)}
                  width={PLOT}
                  height={Math.abs(toSvgY(0) - toSvgY(1))}
                  className="keyframe-curve-box"
                />
                {/* Control arms, drawn so a handle reads as attached to its end. */}
                <line
                  x1={toSvgX(0)}
                  y1={toSvgY(0)}
                  x2={toSvgX(handles.out[0])}
                  y2={toSvgY(handles.out[1])}
                  className="keyframe-curve-arm"
                />
                <line
                  x1={toSvgX(1)}
                  y1={toSvgY(1)}
                  x2={toSvgX(handles.in[0])}
                  y2={toSvgY(handles.in[1])}
                  className="keyframe-curve-arm"
                />
                <path d={path} className="keyframe-curve-line" fill="none" />
                {(['out', 'in'] as const).map((which) => (
                  <circle
                    key={which}
                    cx={toSvgX(handles[which][0])}
                    cy={toSvgY(handles[which][1])}
                    r={5}
                    className="keyframe-curve-handle"
                    data-handle={which}
                    role="slider"
                    tabIndex={0}
                    aria-label={`${which === 'out' ? 'outgoing' : 'incoming'} curve handle`}
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={handles[which][1]}
                    aria-valuetext={`x ${handles[which][0].toFixed(2)}, y ${handles[which][1].toFixed(2)}`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      setGrabbed(which);
                    }}
                    onKeyDown={(event) => {
                      // Keyboard shaping: the whole flow must be completable without
                      // a pointer, and a curve is exactly the kind of control that
                      // usually is not.
                      const step = event.shiftKey ? 0.1 : 0.02;
                      const [x, y] = handles[which];
                      const moved: Record<string, [number, number]> = {
                        ArrowLeft: [clamp01(x - step), y],
                        ArrowRight: [clamp01(x + step), y],
                        ArrowUp: [x, y + step],
                        ArrowDown: [x, y - step],
                      };
                      const nextHandle = moved[event.key];
                      if (!nextHandle) return;
                      event.preventDefault();
                      onHandlesChange(
                        which === 'out'
                          ? { out: nextHandle, in: [...handles.in] as [number, number] }
                          : { out: [...handles.out] as [number, number], in: nextHandle },
                      );
                    }}
                  />
                ))}
              </svg>
              <button
                type="button"
                className="keyframe-curve-reset"
                onClick={() => onHandlesChange(null)}
              >
                Reset curve
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
