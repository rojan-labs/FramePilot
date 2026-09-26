/**
 * A shape clip's glyph on the timeline (plan/elements 02 §6): a small picture of the shape in its
 * own colours beside its name, so a lane of callouts reads at a glance. UI only, like the tiles.
 */
import { memo } from 'react';
import {
  SHAPE_EFFECT_TYPE,
  shapeDescriptor,
  type Clip,
  type ShapePreset,
} from '@framepilot/timeline-schema';
import { ShapeTile } from './ShapesBrowser.js';
import { useShapeIconPaths } from './useShapeIconPaths.js';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const colour = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const ShapeClipGlyph = memo(function ShapeClipGlyph({
  clip,
}: {
  readonly clip: Clip;
}): JSX.Element | null {
  const params = clip.effects.find((effect) => effect.type === SHAPE_EFFECT_TYPE)?.params ?? {};
  const shape = typeof params.shape === 'string' ? shapeDescriptor(params.shape) : undefined;
  const iconPaths = useShapeIconPaths(shape?.geometry?.icon !== undefined);
  if (shape === undefined) return null;
  const knobs = Object.fromEntries(
    shape.knobs.flatMap((knob) =>
      typeof params[knob.name] === 'number' ? [[knob.name, params[knob.name] as number]] : [],
    ),
  );
  const strokeStyle = text(params.strokeStyle);
  const startCap = text(params.startCap);
  const endCap = text(params.endCap);
  const label = text(params.label);
  const labelColor = text(params.labelColor);
  const style: ShapePreset = {
    id: shape.id,
    name: shape.name,
    fill: colour(params.fill),
    stroke: colour(params.stroke),
    strokeWidth: typeof params.strokeWidth === 'number' ? params.strokeWidth : 0.8,
    strokeStyle: strokeStyle === 'dashed' || strokeStyle === 'dotted' ? strokeStyle : 'solid',
    knobs,
    ...(startCap === 'arrow' || startCap === 'dot' || startCap === 'bar' ? { startCap } : {}),
    ...(endCap === 'arrow' || endCap === 'dot' || endCap === 'bar' ? { endCap } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(labelColor !== undefined ? { labelColor } : {}),
  };
  return (
    <ShapeTile shape={shape} preset={style} iconPaths={iconPaths} className="clip-shape-glyph" />
  );
});
