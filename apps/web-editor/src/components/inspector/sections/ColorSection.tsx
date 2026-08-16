/** Color adjustment controls, grouped by the way editors scan them. */
import { useState } from 'react';
import { Button } from '@framepilot/ui';
import type { Clip } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  type ColorGradeParams,
  colorGradeParams,
  isIdentityGrade,
} from '../../../editor/selectors.js';
import { setColorGradePatch } from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';

interface GradeControl {
  readonly key: keyof ColorGradeParams;
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

const LIGHT_CONTROLS: readonly GradeControl[] = [
  { key: 'exposure', label: 'Exposure', min: -2, max: 2 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1 },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1 },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1 },
];

const COLOR_CONTROLS: readonly GradeControl[] = [
  { key: 'saturation', label: 'Saturation', min: -1, max: 1 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1 },
  { key: 'tint', label: 'Tint', min: -1, max: 1 },
];

export function ColorPanel({
  editor,
  clip,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
}): JSX.Element {
  const [grade, setGrade] = useState<ColorGradeParams>(() => colorGradeParams(clip));
  const set = (key: keyof ColorGradeParams, value: number): void =>
    setGrade((prev) => ({ ...prev, [key]: value }));

  const apply = (next: ColorGradeParams): void => {
    const patch = setColorGradePatch(editor.state.timeline, clip.id, { ...next });
    if (patch) editor.applyPatch(patch);
  };

  const renderControls = (controls: readonly GradeControl[]): JSX.Element[] =>
    controls.map((control) => (
      <ScrubNumber
        key={control.key}
        label={control.label}
        ariaLabel={control.label.toLowerCase()}
        value={grade[control.key]}
        min={control.min}
        max={control.max}
        step={0.05}
        defaultValue={0}
        onChange={(value) => set(control.key, value)}
      />
    ));

  return (
    <div className="inspector-subpanel" aria-label="color grade">
      <div className="inspector-control-cluster">
        <h4>Light</h4>
        {renderControls(LIGHT_CONTROLS)}
      </div>
      <div className="inspector-control-cluster">
        <h4>Color</h4>
        {renderControls(COLOR_CONTROLS)}
      </div>
      <div className="inspector-actions">
        <Button
          variant="secondary"
          type="button"
          onClick={() => apply(grade)}
          disabled={isIdentityGrade(grade) && isIdentityGrade(colorGradeParams(clip))}
        >
          Apply adjustments
        </Button>
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            setGrade(identityGrade());
            apply(identityGrade());
          }}
          disabled={isIdentityGrade(colorGradeParams(clip))}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

export function identityGrade(): ColorGradeParams {
  return {
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    shadows: 0,
    highlights: 0,
  };
}
