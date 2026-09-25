/**
 * The Inspector's Shape section (plan/elements EL4a): fill, stroke, the shape's own knobs, its
 * box or its two ends. Every change is one `set_effect_params` patch; a change that would leave
 * the shape drawing nothing is not applied, and the section says why.
 */
import { useState } from 'react';
import type { Clip } from '@framepilot/timeline-schema';
import {
  SHAPE_CAPS,
  SHAPE_EFFECT_TYPE,
  SHAPE_LIMITS,
  SHAPE_STROKE_STYLES,
  shapeDescriptor,
  shapeParamsProblem,
} from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import { setShapeParamsPatch } from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';
import { Checkbox } from '../../Checkbox.js';
import { LabeledSelect } from '../LabeledSelect.js';

/** `#rrggbb` part and alpha (0–100 %) of a stored `#rrggbb[aa]` colour. */
function splitColour(colour: string): { readonly rgb: string; readonly alpha: number } {
  const alpha = colour.length === 9 ? parseInt(colour.slice(7, 9), 16) : 255;
  return { rgb: colour.slice(0, 7).toLowerCase(), alpha: Math.round((alpha / 255) * 100) };
}

/** A stored colour from a picker's `#rrggbb` and an opacity percentage. */
function joinColour(rgb: string, alphaPercent: number): string {
  const alpha = Math.round((Math.min(100, Math.max(0, alphaPercent)) / 100) * 255);
  return alpha >= 255 ? rgb : `${rgb}${alpha.toString(16).padStart(2, '0')}`;
}

/** The colour a paint gets when it is switched on. */
const DEFAULT_ON: Readonly<Record<'fill' | 'stroke', string>> = {
  fill: '#ffffff',
  stroke: '#ffd400',
};

function PaintControls({
  which,
  value,
  onChange,
}: {
  readonly which: 'fill' | 'stroke';
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
}): JSX.Element {
  const label = which === 'fill' ? 'Fill' : 'Stroke';
  const parts = value === null ? null : splitColour(value);
  return (
    <div className="inspector-color-row">
      <Checkbox
        ariaLabel={`shape ${which}`}
        checked={value !== null}
        onChange={(on) => onChange(on ? DEFAULT_ON[which] : null)}
      >
        {label}
      </Checkbox>
      {parts !== null && (
        <>
          <input
            type="color"
            aria-label={`shape ${which} color`}
            value={parts.rgb}
            onChange={(event) => onChange(joinColour(event.target.value, parts.alpha))}
          />
          <ScrubNumber
            label="Opacity %"
            ariaLabel={`shape ${which} opacity`}
            value={parts.alpha}
            min={0}
            max={100}
            step={1}
            onChange={(alpha) => onChange(joinColour(parts.rgb, alpha))}
          />
        </>
      )}
    </div>
  );
}

export function ShapeInspector({
  editor,
  clip,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
}): JSX.Element | null {
  const [refusal, setRefusal] = useState<string | null>(null);
  const effect = clip.effects.find((candidate) => candidate.type === SHAPE_EFFECT_TYPE);
  const params = effect?.params ?? {};
  const descriptor = typeof params.shape === 'string' ? shapeDescriptor(params.shape) : undefined;
  if (effect === undefined || descriptor === undefined) return null;

  const commit = (changes: Readonly<Record<string, unknown>>, what: string): void => {
    const patch = setShapeParamsPatch(editor.state.timeline, clip.id, changes, what);
    if (patch === null) {
      // Say why rather than dropping the edit: the validator's own sentence names the fix.
      setRefusal(shapeParamsProblem({ ...params, ...changes }) ?? 'That change was not applied.');
      return;
    }
    setRefusal(null);
    editor.applyPatch(patch);
  };
  const number = (key: string, fallback = 0): number => {
    const value = params[key];
    return typeof value === 'number' ? value : fallback;
  };
  const colour = (key: 'fill' | 'stroke'): string | null => {
    const value = params[key];
    return typeof value === 'string' ? value : null;
  };
  const segment = descriptor.frame === 'segment';
  const frameKeys = segment
    ? ([
        ['x1', 'Start X %'],
        ['y1', 'Start Y %'],
        ['x2', 'End X %'],
        ['y2', 'End Y %'],
      ] as const)
    : ([
        ['x', 'X %'],
        ['y', 'Y %'],
        ['width', 'Width %'],
        ['height', 'Height %'],
      ] as const);
  const limitsFor = (key: string): { readonly min: number; readonly max: number } =>
    segment
      ? SHAPE_LIMITS.endpoint
      : key === 'width' || key === 'height'
        ? SHAPE_LIMITS.size
        : SHAPE_LIMITS.position;

  return (
    <>
      <div className="inspector-subpanel" aria-label="shape style">
        {!segment && (
          <PaintControls
            which="fill"
            value={colour('fill')}
            onChange={(v) => commit({ fill: v }, 'fill')}
          />
        )}
        <PaintControls
          which="stroke"
          value={colour('stroke')}
          onChange={(v) => commit({ stroke: v }, 'stroke')}
        />
        {colour('stroke') !== null && (
          <>
            <ScrubNumber
              label="Stroke %"
              ariaLabel="shape stroke width"
              value={number('strokeWidth', 0.8)}
              min={SHAPE_LIMITS.strokeWidth.min}
              max={SHAPE_LIMITS.strokeWidth.max}
              step={0.05}
              onChange={(value) => commit({ strokeWidth: value }, 'stroke width')}
            />
            <LabeledSelect
              caption="Line"
              label="shape stroke style"
              value={typeof params.strokeStyle === 'string' ? params.strokeStyle : 'solid'}
              options={SHAPE_STROKE_STYLES}
              onChange={(value) => commit({ strokeStyle: value }, 'stroke style')}
            />
          </>
        )}
        {descriptor.knobs.map((knob) => (
          <ScrubNumber
            key={knob.name}
            label={`${knob.label} ${knob.unit}`}
            ariaLabel={`shape ${knob.label.toLowerCase()}`}
            value={number(knob.name, knob.default)}
            min={knob.min}
            max={knob.max}
            step={knob.unit === '%' ? 1 : 0.5}
            onChange={(value) => commit({ [knob.name]: value }, knob.label.toLowerCase())}
          />
        ))}
        {segment && (
          <>
            <LabeledSelect
              caption="Start"
              label="shape start cap"
              value={typeof params.startCap === 'string' ? params.startCap : 'none'}
              options={SHAPE_CAPS}
              onChange={(value) => commit({ startCap: value }, 'start')}
            />
            <LabeledSelect
              caption="End"
              label="shape end cap"
              value={typeof params.endCap === 'string' ? params.endCap : 'none'}
              options={SHAPE_CAPS}
              onChange={(value) => commit({ endCap: value }, 'end')}
            />
          </>
        )}
      </div>

      <div className="inspector-subpanel" aria-label="shape placement">
        <h4>{segment ? 'Ends' : 'Box'}</h4>
        {frameKeys.map(([key, label]) => {
          const limits = limitsFor(key);
          return (
            <ScrubNumber
              key={key}
              label={label}
              ariaLabel={`shape ${key}`}
              value={number(key)}
              min={limits.min}
              max={limits.max}
              step={0.5}
              onChange={(value) => commit({ [key]: value }, segment ? 'ends' : 'box')}
            />
          );
        })}
      </div>
      {refusal !== null && (
        <p className="inspector-note" role="status">
          {refusal}
        </p>
      )}
    </>
  );
}
