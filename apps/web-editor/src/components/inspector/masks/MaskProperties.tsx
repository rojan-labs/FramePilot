/**
 * The selected mask's properties (MK4.2): target, opacity, expansion, feathers and falloff, and
 * the shape's geometry in source pixels, each animatable property with its keyframe control.
 *
 * Values are read at the playhead's SOURCE instant (mask keyframes live on the source clock,
 * ADR 0178). An edit keys the instant when the property is animated and changes the static value
 * when it is not; with "Apply to all keyframes" on, an animated property shifts by the same
 * amount on every keyframe instead (one `update_mask`). The commands decide which, so the panel
 * and the monitor behave identically.
 */
import { Switch } from '@framepilot/ui';
import {
  MASK_ANIMATABLE_PROPERTIES,
  maskGeometryAt,
  maskScalarAt,
  type MaskGeometry,
} from '@framepilot/editor-core';
import type { Clip, Keyframe, MaskLayer, MaskScalarProperty } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  clipTimelineTimeForSource,
  runMaskCommand,
  type MaskCommandInput,
} from '../../../editor/mask-editing.js';
import { KeyframeButton } from '../KeyframeButton.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { InspectorRow } from '../InspectorRow.js';
import { keyframeStateAt } from '../keyframe-state.js';
import { MaskKeyControls } from './MaskKeyControls.js';
import { MaskNumberField } from './MaskNumberField.js';
import { maskToolStore, useMaskTools, type MaskToolStore } from './useMaskTools.js';

interface NumberRow {
  readonly property: MaskScalarProperty;
  readonly label: string;
  readonly step: number;
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
}

const EDGE_ROWS: readonly NumberRow[] = [
  { property: 'opacity', label: 'Opacity', step: 0.01, min: 0, max: 1 },
  { property: 'expansionPx', label: 'Expansion', step: 1, unit: 'px' },
  { property: 'featherOuterPx', label: 'Outer feather', step: 1, min: 0, unit: 'px' },
  { property: 'featherInnerPx', label: 'Inner feather', step: 1, min: 0, unit: 'px' },
];

type RowKind = 'rectangle' | 'ellipse' | 'linear' | 'band' | 'gradient';

const GEOMETRY_ROWS: Readonly<Record<RowKind, readonly NumberRow[]>> = {
  rectangle: [
    { property: 'cx', label: 'Centre X', step: 1, unit: 'px' },
    { property: 'cy', label: 'Centre Y', step: 1, unit: 'px' },
    { property: 'width', label: 'Width', step: 1, min: 0, unit: 'px' },
    { property: 'height', label: 'Height', step: 1, min: 0, unit: 'px' },
    { property: 'rotation', label: 'Rotation', step: 1, unit: '°' },
    { property: 'roundness', label: 'Roundness', step: 0.01, min: 0, max: 1 },
  ],
  ellipse: [
    { property: 'cx', label: 'Centre X', step: 1, unit: 'px' },
    { property: 'cy', label: 'Centre Y', step: 1, unit: 'px' },
    { property: 'rx', label: 'Radius X', step: 1, min: 0, unit: 'px' },
    { property: 'ry', label: 'Radius Y', step: 1, min: 0, unit: 'px' },
    { property: 'rotation', label: 'Rotation', step: 1, unit: '°' },
  ],
  // MK8.1: the analytic kinds, typed in source pixels like the shapes.
  linear: [
    { property: 'originX', label: 'Line X', step: 1, unit: 'px' },
    { property: 'originY', label: 'Line Y', step: 1, unit: 'px' },
    { property: 'angle', label: 'Angle', step: 1, unit: '°' },
    { property: 'softnessPx', label: 'Softness', step: 1, min: 0, unit: 'px' },
  ],
  band: [
    { property: 'originX', label: 'Centre X', step: 1, unit: 'px' },
    { property: 'originY', label: 'Centre Y', step: 1, unit: 'px' },
    { property: 'angle', label: 'Angle', step: 1, unit: '°' },
    { property: 'widthPx', label: 'Width', step: 1, min: 0, unit: 'px' },
    { property: 'softnessPx', label: 'Softness', step: 1, min: 0, unit: 'px' },
  ],
  gradient: [
    { property: 'startX', label: 'Start X', step: 1, unit: 'px' },
    { property: 'startY', label: 'Start Y', step: 1, unit: 'px' },
    { property: 'endX', label: 'End X', step: 1, unit: 'px' },
    { property: 'endY', label: 'End Y', step: 1, unit: 'px' },
  ],
};

/** Kinds whose geometry is a row list above (the path has its own point editor). */
const hasGeometryRows = (kind: MaskLayer['kind']): kind is RowKind =>
  kind === 'rectangle' ||
  kind === 'ellipse' ||
  kind === 'linear' ||
  kind === 'band' ||
  kind === 'gradient';

/** A gradient has no edge, so it shows neither expansion nor feathers nor a falloff (MK8.1). */
const GRADIENT_EDGE_ROWS: readonly NumberRow[] = EDGE_ROWS.filter(
  (row) => row.property === 'opacity',
);

const GRADIENT_SHAPES = ['linear', 'radial'] as const;
const GRADIENT_SHAPE_LABELS = ['Linear', 'Radial'] as const;

const FALLOFFS = ['linear', 'smooth', 'gaussian'] as const;
const FALLOFF_LABELS = ['Linear', 'Smooth', 'Gaussian'] as const;

export interface MaskPropertiesProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly mask: MaskLayer;
  readonly name: string;
  readonly sourceTime: number;
  readonly store?: MaskToolStore;
}

/** A mask property's keyframes in the clip-keyframe shape the keyframe control reads. */
function propertyKeyframes(mask: MaskLayer, property: MaskScalarProperty | 'path'): Keyframe[] {
  if (property === 'path') {
    if (mask.kind !== 'path') return [];
    // One path keyframe is a static shape, not an animation.
    if (mask.pathKeyframes.length < 2) return [];
    return mask.pathKeyframes.map((keyframe) => ({
      id: keyframe.id,
      time: keyframe.sourceTime,
      property: 'path',
      value: 0,
      easing: keyframe.easing,
    }));
  }
  return mask.keyframes
    .filter((keyframe) => keyframe.property === property)
    .map((keyframe) => ({
      id: keyframe.id,
      time: keyframe.sourceTime,
      property,
      value: keyframe.value,
      easing: keyframe.easing,
    }));
}

export function MaskProperties({
  editor,
  clip,
  mask,
  name,
  sourceTime,
  store = maskToolStore,
}: MaskPropertiesProps): JSX.Element {
  const tools = useMaskTools(store);
  const locked = mask.locked;
  const animatable: readonly string[] = MASK_ANIMATABLE_PROPERTIES[mask.kind];

  const run = (command: MaskCommandInput): void => {
    store.update({ message: runMaskCommand(editor, command) });
  };

  const keyframeControl = (property: MaskScalarProperty | 'path', label: string): JSX.Element => {
    const base = keyframeStateAt(propertyKeyframes(mask, property), property, sourceTime);
    return (
      <KeyframeButton
        state={{ ...base, pulsing: false }}
        label={`${name} ${label.toLowerCase()}`}
        onToggle={() =>
          run({
            type: 'toggle_mask_keyframe',
            clipId: clip.id,
            maskId: mask.id,
            property,
            sourceTime,
          })
        }
        onSeek={(time) => editor.seek(clipTimelineTimeForSource(clip, time))}
      />
    );
  };

  const liveValue = (property: MaskScalarProperty): number | undefined => {
    const live = tools.liveScalars;
    if (live !== null && live.maskId === mask.id) return live.values[property];
    return undefined;
  };

  const numberRow = (row: NumberRow): JSX.Element => (
    <MaskNumberField
      key={row.property}
      label={row.label}
      name={`${name} ${row.label.toLowerCase()}`}
      value={liveValue(row.property) ?? maskScalarAt(mask, row.property, sourceTime) ?? 0}
      step={row.step}
      disabled={locked}
      {...(row.min === undefined ? {} : { min: row.min })}
      {...(row.max === undefined ? {} : { max: row.max })}
      {...(row.unit === undefined ? {} : { unit: row.unit })}
      onLive={(value) =>
        store.update({
          liveScalars:
            value === null
              ? null
              : { clipId: clip.id, maskId: mask.id, values: { [row.property]: value } },
        })
      }
      onCommit={(value) =>
        run({
          type: 'set_mask_properties',
          clipId: clip.id,
          maskId: mask.id,
          sourceTime,
          changes: { [row.property]: value },
          allKeyframes: tools.allKeyframes,
        })
      }
      {...(animatable.includes(row.property)
        ? { keyframe: keyframeControl(row.property, row.label) }
        : {})}
    />
  );

  const effects = clip.effects.filter(
    (effect) => effect.type !== 'transition' && effect.type !== 'transition_out',
  );
  const targetValue = mask.target.kind === 'alpha' ? 'alpha' : mask.target.effectId;
  const geometry: MaskGeometry | null = maskGeometryAt(mask, sourceTime);
  const selectedPoint =
    geometry?.kind === 'path' && tools.selectedVertices.length === 1
      ? { index: tools.selectedVertices[0]!, vertex: geometry.vertices[tools.selectedVertices[0]!] }
      : null;

  const movePoint = (axis: 'x' | 'y', value: number): void => {
    if (geometry?.kind !== 'path' || selectedPoint?.vertex === undefined) return;
    run({
      type: 'set_mask_geometry',
      clipId: clip.id,
      maskId: mask.id,
      sourceTime,
      geometry: {
        kind: 'path',
        vertices: geometry.vertices.map((vertex, index) =>
          index === selectedPoint.index ? { ...vertex, [axis]: value } : vertex,
        ),
      },
    });
  };

  return (
    <div className="inspector-subpanel mask-properties" aria-label={`${name} properties`}>
      {locked && (
        <p className="inspector-empty inspector-empty-inline" role="note">
          Locked. Unlock the mask to change it.
        </p>
      )}
      <LabeledSelect
        caption="Limits"
        label={`${name} target`}
        value={targetValue}
        options={['alpha', ...effects.map((effect) => effect.id)]}
        labels={['Clip', ...effects.map((effect) => `Effect: ${effect.type}`)]}
        onChange={(value) =>
          run({
            type: 'set_mask_target',
            clipId: clip.id,
            maskId: mask.id,
            target: value === 'alpha' ? { kind: 'alpha' } : { kind: 'effect', effectId: value },
          })
        }
      />
      {(mask.kind === 'gradient' ? GRADIENT_EDGE_ROWS : EDGE_ROWS).map(numberRow)}
      {mask.kind === 'gradient' && (
        <>
          <LabeledSelect
            caption="Shape"
            label={`${name} gradient shape`}
            value={mask.shape}
            options={GRADIENT_SHAPES}
            labels={GRADIENT_SHAPE_LABELS}
            onChange={(value) =>
              run({
                type: 'set_mask_properties',
                clipId: clip.id,
                maskId: mask.id,
                sourceTime,
                changes: { shape: value },
              })
            }
          />
          <LabeledSelect
            caption="Curve"
            label={`${name} gradient curve`}
            value={mask.curve}
            options={FALLOFFS}
            labels={FALLOFF_LABELS}
            onChange={(value) =>
              run({
                type: 'set_mask_properties',
                clipId: clip.id,
                maskId: mask.id,
                sourceTime,
                changes: { curve: value },
              })
            }
          />
        </>
      )}
      {mask.kind !== 'gradient' && (
        <LabeledSelect
          caption="Falloff"
          label={`${name} falloff`}
          value={mask.falloff}
          options={FALLOFFS}
          labels={FALLOFF_LABELS}
          onChange={(value) =>
            run({
              type: 'set_mask_properties',
              clipId: clip.id,
              maskId: mask.id,
              sourceTime,
              changes: { falloff: value },
            })
          }
        />
      )}
      {mask.kind === 'key' && (
        <MaskKeyControls
          editor={editor}
          clip={clip}
          mask={mask}
          name={name}
          sourceTime={sourceTime}
          locked={locked}
          store={store}
        />
      )}
      {hasGeometryRows(mask.kind) && GEOMETRY_ROWS[mask.kind].map(numberRow)}
      {mask.kind === 'path' && geometry?.kind === 'path' && (
        <>
          <InspectorRow
            label="Path"
            name={`${name} path`}
            keyframe={keyframeControl('path', 'Path')}
          >
            <span className="inspector-row-value tabular">{`${String(geometry.vertices.length)} points`}</span>
          </InspectorRow>
          {selectedPoint?.vertex !== undefined ? (
            <>
              <MaskNumberField
                label="Point X"
                name={`${name} point x`}
                value={selectedPoint.vertex.x}
                step={1}
                unit="px"
                disabled={locked}
                onCommit={(value) => movePoint('x', value)}
              />
              <MaskNumberField
                label="Point Y"
                name={`${name} point y`}
                value={selectedPoint.vertex.y}
                step={1}
                unit="px"
                disabled={locked}
                onCommit={(value) => movePoint('y', value)}
              />
            </>
          ) : (
            <p className="inspector-empty inspector-empty-inline">
              Select one point on the monitor to type its position.
            </p>
          )}
        </>
      )}
      <InspectorRow label="All keyframes" name="apply to all keyframes">
        <Switch
          checked={tools.allKeyframes}
          label="Apply to all keyframes"
          onCheckedChange={(checked) => store.update({ allKeyframes: checked })}
        />
      </InspectorRow>
    </div>
  );
}
