/**
 * Mask presets saved in the project (MK4.3): save the selected mask under a name, apply a preset
 * to the clip (rescaled to its picture), delete one. Presets live in the project file through
 * typed operations, so they travel with the project and every change undoes.
 */
import { useState } from 'react';
import type { MaskPreset } from '@framepilot/timeline-schema';
import { InspectorRow } from '../InspectorRow.js';
import { Select } from '../../Select.js';

export interface MaskPresetsProps {
  readonly presets: readonly MaskPreset[];
  readonly canSave: boolean;
  readonly canApply: boolean;
  readonly onSave: (name: string) => void;
  readonly onApply: (presetId: string) => void;
  readonly onRemove: (presetId: string) => void;
}

export function MaskPresets({
  presets,
  canSave,
  canApply,
  onSave,
  onApply,
  onRemove,
}: MaskPresetsProps): JSX.Element {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string>('');
  const current = presets.some((preset) => preset.id === chosen) ? chosen : (presets[0]?.id ?? '');

  const save = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || !canSave) return;
    onSave(trimmed);
    setName('');
  };

  return (
    <div className="mask-presets" role="group" aria-label="Mask presets">
      <InspectorRow label="Save as" name="mask preset name">
        <span className="mask-presets-save">
          <input
            type="text"
            className="mask-number-input"
            aria-label="Preset name"
            placeholder="Preset name"
            value={name}
            disabled={!canSave}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
            }}
          />
          <button
            type="button"
            className="inspector-text-button"
            disabled={!canSave || name.trim() === ''}
            onClick={save}
          >
            Save preset
          </button>
        </span>
      </InspectorRow>
      {presets.length > 0 && (
        <InspectorRow label="Presets" name="mask presets">
          <span className="mask-presets-save">
            <Select
              label="Mask preset"
              value={current}
              onChange={setChosen}
              options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
            />
            <button
              type="button"
              className="inspector-text-button"
              disabled={!canApply || current === ''}
              onClick={() => onApply(current)}
            >
              Apply preset
            </button>
            <button
              type="button"
              className="inspector-text-button"
              disabled={current === ''}
              onClick={() => onRemove(current)}
            >
              Delete preset
            </button>
          </span>
        </InspectorRow>
      )}
    </div>
  );
}
