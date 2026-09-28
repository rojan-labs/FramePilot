/**
 * Text-overlay section body (revamp Phase 4 — extracted from the monolithic
 * Inspector). Title/label/order/open state live in the registry.
 */
import type { Clip } from '@framepilot/timeline-schema';
import {
  PLAIN_TITLE_TYPOGRAPHY,
  type TitleChipShape,
  type TitleTypography,
} from '@framepilot/timeline-schema/title-templates';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  TEXT_ALIGNMENTS,
  type TextOverlayParams,
  readTextParams,
  setTextParamsPatch,
} from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';
import { Checkbox } from '../../Checkbox.js';
import { FontFamilySelect, fontHasItalic, fontWeightsFor } from '../../FontFamilySelect.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { InspectorRow } from '../InspectorRow.js';

const TEXT_CASES = ['none', 'uppercase', 'lowercase'] as const;
const TEXT_CASE_LABELS = ['As typed', 'UPPERCASE', 'lowercase'] as const;

/**
 * Shadow presets, in the caption catalog's units (fractions of the font size). A preset keeps
 * the colour the shadow already has, so choosing a softer one never turns a coloured glow black.
 */
const SHADOW_PRESETS = {
  none: null,
  soft: { blur: 0.2, offsetX: 0, offsetY: 0.06 },
  halo: { blur: 0.26, offsetX: 0, offsetY: 0.02 },
  hard: { blur: 0, offsetX: 0.05, offsetY: 0.07 },
  glow: { blur: 0.55, offsetX: 0, offsetY: 0 },
} as const;
type ShadowPreset = keyof typeof SHADOW_PRESETS;
const SHADOW_PRESET_IDS = Object.keys(SHADOW_PRESETS) as ShadowPreset[];
const SHADOW_PRESET_LABELS = ['None', 'Soft', 'Halo', 'Hard', 'Glow'];
const DEFAULT_SHADOW_COLOR = '#000000b3';
const DEFAULT_OUTLINE_WIDTH = 1.5;
/** The caption renderer's line height when a typography names none. */
const DEFAULT_LINE_HEIGHT = 1.25;
/** A chip's default shape (the caption renderer's). */
const DEFAULT_CHIP_RADIUS = 0.35;
const DEFAULT_CHIP_PADDING = 0.35;

/** The preset a stored shadow matches, or `soft` for any hand-tuned one. */
function shadowPresetOf(shadow: TitleTypography['shadow']): ShadowPreset {
  if (shadow === undefined) return 'none';
  const match = SHADOW_PRESET_IDS.find((id) => {
    const preset = SHADOW_PRESETS[id];
    return (
      preset !== null &&
      preset.blur === shadow.blur &&
      preset.offsetX === shadow.offsetX &&
      preset.offsetY === shadow.offsetY
    );
  });
  return match ?? 'soft';
}

/** A `#rrggbb` for an `<input type=color>`, which cannot show an alpha. */
function opaque(color: string): string {
  return /^#[0-9a-f]{8}$/i.test(color) ? color.slice(0, 7) : color;
}

/** The weight nearest `weight` that `family` has, so a family change never asks for a face it lacks. */
function nearestWeight(family: string, weight: number): number {
  const weights = fontWeightsFor(family);
  return weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best));
}

/** `typography` without `key` (turning a property off removes it rather than zeroing it). */
function without<K extends keyof TitleTypography>(
  typography: TitleTypography,
  key: K,
): TitleTypography {
  const { [key]: _removed, ...rest } = typography;
  return rest;
}

/**
 * Text-overlay styling panel (#5). Reads the selected text clip's params and
 * writes each change as one reversible `set_effect_params` edit. Re-mounted per
 * clip (via `key`) so it always reflects the selected overlay's real params. The
 * program monitor shows a live styled preview of the same params.
 *
 * Titles take the caption typography (`title-templates.ts`): the same bundled fonts as captions,
 * and case, italic, tracking, line height, see-through letters, outline, shadow and chip shape.
 * A plain title reads as {@link PLAIN_TITLE_TYPOGRAPHY} (its fixed black stroke), and its first
 * typography edit starts from that, so converting it keeps the look it had.
 */
export function TextOverlayInspector({
  editor,
  clip,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
}): JSX.Element {
  const params = readTextParams(clip);
  const typography = params.typography ?? PLAIN_TITLE_TYPOGRAPHY;
  const commit = (patch: Partial<TextOverlayParams>): void => {
    const built = setTextParamsPatch(editor.state.timeline, clip.id, patch);
    if (built) editor.applyPatch(built);
  };
  const setTypography = (next: TitleTypography): void => commit({ typography: next });
  const merge = (fields: Partial<TitleTypography>): void =>
    setTypography({ ...typography, ...fields });
  const setChip = (fields: Partial<TitleChipShape>): void =>
    merge({ background: { ...typography.background, ...fields } });

  const weights = fontWeightsFor(params.fontFamily);
  const weightOptions = (
    weights.includes(params.fontWeight) ? weights : [...weights, params.fontWeight]
  ).map(String);
  const italicAvailable = fontHasItalic(params.fontFamily);
  const outlineOn = typography.outlineColor !== undefined && (typography.outlineWidth ?? 0) > 0;
  const shadow = typography.shadow;

  const changeFamily = (family: string): void => {
    const patch: Partial<TextOverlayParams> = {
      fontFamily: family,
      fontWeight: nearestWeight(family, params.fontWeight),
    };
    // An italic the new family does not ship would be drawn upright by both renderers anyway;
    // clearing it keeps the Inspector truthful.
    if (typography.fontStyle === 'italic' && !fontHasItalic(family)) {
      commit({ ...patch, typography: without(typography, 'fontStyle') });
      return;
    }
    commit(patch);
  };

  return (
    <>
      <div className="inspector-subpanel" aria-label="text style">
        <label className="inspector-field">
          <span className="inspector-select-caption">Content</span>
          <textarea
            className="inspector-textarea"
            aria-label="text content"
            value={params.text}
            rows={2}
            onChange={(event) => commit({ text: event.target.value })}
          />
        </label>
        <InspectorRow label="Font" name="font family">
          <FontFamilySelect label="font family" value={params.fontFamily} onChange={changeFamily} />
        </InspectorRow>
        <LabeledSelect
          caption="Weight"
          label="font weight"
          value={String(params.fontWeight)}
          options={weightOptions}
          onChange={(value) => commit({ fontWeight: Number(value) })}
        />
        <div className="inspector-color-row">
          <span className="inspector-select-caption">Color</span>
          <input
            type="color"
            aria-label="text color"
            value={opaque(params.color)}
            onChange={(event) => commit({ color: event.target.value })}
          />
        </div>
        <ScrubNumber
          label="Size %"
          ariaLabel="font size"
          value={params.fontSizePercent}
          min={2}
          max={40}
          step={0.5}
          onChange={(value) => commit({ fontSizePercent: value })}
        />
        <LabeledSelect
          caption="Align"
          label="text align"
          value={params.align}
          options={TEXT_ALIGNMENTS}
          onChange={(value) => commit({ align: value })}
        />
      </div>

      <div className="inspector-subpanel" aria-label="text typography">
        <h4>Typography</h4>
        <LabeledSelect
          caption="Case"
          label="text case"
          value={typography.textTransform ?? 'none'}
          options={TEXT_CASES}
          labels={TEXT_CASE_LABELS}
          onChange={(value) =>
            setTypography(
              value === 'none'
                ? without(typography, 'textTransform')
                : { ...typography, textTransform: value },
            )
          }
        />
        {italicAvailable && (
          <div className="inspector-color-row">
            <Checkbox
              ariaLabel="italic"
              checked={typography.fontStyle === 'italic'}
              onChange={(on) =>
                setTypography(
                  on ? { ...typography, fontStyle: 'italic' } : without(typography, 'fontStyle'),
                )
              }
            >
              Italic
            </Checkbox>
          </div>
        )}
        <ScrubNumber
          label="Spacing"
          ariaLabel="letter spacing"
          unit="%"
          value={Math.round((typography.letterSpacing ?? 0) * 100)}
          min={-10}
          max={60}
          step={1}
          onChange={(value) => merge({ letterSpacing: value / 100 })}
        />
        <ScrubNumber
          label="Line height"
          ariaLabel="line height"
          value={typography.lineHeight ?? DEFAULT_LINE_HEIGHT}
          min={0.8}
          max={2.5}
          step={0.05}
          defaultValue={DEFAULT_LINE_HEIGHT}
          onChange={(value) => merge({ lineHeight: value })}
        />
        <ScrubNumber
          label="Letters"
          ariaLabel="letter opacity"
          unit="%"
          value={Math.round((typography.textOpacity ?? 1) * 100)}
          min={0}
          max={100}
          step={5}
          onChange={(value) =>
            setTypography(
              value >= 100
                ? without(typography, 'textOpacity')
                : { ...typography, textOpacity: value / 100 },
            )
          }
        />
        <div className="inspector-color-row">
          <Checkbox
            ariaLabel="outline"
            checked={outlineOn}
            onChange={(on) =>
              setTypography(
                on
                  ? {
                      ...typography,
                      outlineColor: typography.outlineColor ?? '#000000',
                      outlineWidth: DEFAULT_OUTLINE_WIDTH,
                    }
                  : without(without(typography, 'outlineColor'), 'outlineWidth'),
              )
            }
          >
            Outline
          </Checkbox>
          {outlineOn && (
            <input
              type="color"
              aria-label="outline color"
              value={opaque(typography.outlineColor ?? '#000000')}
              onChange={(event) => merge({ outlineColor: event.target.value })}
            />
          )}
        </div>
        {outlineOn && (
          <ScrubNumber
            label="Outline"
            ariaLabel="outline width"
            value={typography.outlineWidth ?? DEFAULT_OUTLINE_WIDTH}
            min={0.5}
            max={4}
            step={0.25}
            onChange={(value) => merge({ outlineWidth: value })}
          />
        )}
        <LabeledSelect
          caption="Shadow"
          label="text shadow"
          value={shadowPresetOf(shadow)}
          options={SHADOW_PRESET_IDS}
          labels={SHADOW_PRESET_LABELS}
          onChange={(value) => {
            const preset = SHADOW_PRESETS[value];
            setTypography(
              preset === null
                ? without(typography, 'shadow')
                : {
                    ...typography,
                    shadow: { color: shadow?.color ?? DEFAULT_SHADOW_COLOR, ...preset },
                  },
            );
          }}
        />
        {shadow !== undefined && (
          <div className="inspector-color-row">
            <span className="inspector-select-caption">Shadow color</span>
            <input
              type="color"
              aria-label="shadow color"
              value={opaque(shadow.color)}
              onChange={(event) => merge({ shadow: { ...shadow, color: event.target.value } })}
            />
          </div>
        )}
      </div>

      <div className="inspector-subpanel" aria-label="text layout">
        <h4>Layout</h4>
        <ScrubNumber
          label="Box width %"
          ariaLabel="box width"
          value={params.boxWidthPercent}
          min={10}
          max={100}
          step={1}
          onChange={(value) => commit({ boxWidthPercent: value })}
        />
        <ScrubNumber
          label="X %"
          ariaLabel="position x"
          value={params.xPercent}
          min={0}
          max={100}
          step={1}
          onChange={(value) => commit({ xPercent: value })}
        />
        <ScrubNumber
          label="Y %"
          ariaLabel="position y"
          value={params.yPercent}
          min={0}
          max={100}
          step={1}
          onChange={(value) => commit({ yPercent: value })}
        />
        <div className="inspector-color-row">
          <Checkbox
            ariaLabel="background"
            checked={params.background !== null}
            onChange={(on) => commit({ background: on ? '#000000' : null })}
          >
            Background
          </Checkbox>
          {params.background !== null && (
            <input
              type="color"
              aria-label="background color"
              value={opaque(params.background)}
              onChange={(event) => commit({ background: event.target.value })}
            />
          )}
        </div>
        {params.background !== null && (
          <>
            <ScrubNumber
              label="Corners"
              ariaLabel="background corner radius"
              value={typography.background?.radius ?? DEFAULT_CHIP_RADIUS}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setChip({ radius: value })}
            />
            <ScrubNumber
              label="Pad X"
              ariaLabel="background horizontal padding"
              value={typography.background?.paddingX ?? DEFAULT_CHIP_PADDING}
              min={0}
              max={1.5}
              step={0.05}
              onChange={(value) => setChip({ paddingX: value })}
            />
            <ScrubNumber
              label="Pad Y"
              ariaLabel="background vertical padding"
              value={typography.background?.paddingY ?? DEFAULT_CHIP_PADDING}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setChip({ paddingY: value })}
            />
          </>
        )}
      </div>

      {/* plan/elements EL7: a title's In, Out and Loop are the shared Animation section's (Basic
          tab), written as layer transitions; the old In/Out params are only read now. */}
      <p className="inspector-note">In, Out and Loop are in Animation, on the Basic tab.</p>
    </>
  );
}
