/**
 * Text-overlay section body (revamp Phase 4 — extracted from the monolithic
 * Inspector). Title/label/order/open state live in the registry.
 */
import type { Clip } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  TEXT_ALIGNMENTS,
  TEXT_ANIMATIONS,
  type TextOverlayParams,
  readTextParams,
  setTextParamsPatch,
} from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';
import { Checkbox } from '../../Checkbox.js';
import { LabeledSelect } from '../LabeledSelect.js';

/** Font families offered for text overlays (values are valid CSS font stacks). */
const TEXT_FONTS = ['Inter', 'Georgia', 'Impact', 'Courier New', 'Arial', 'Verdana'] as const;
/** Font weights offered for text overlays. */
const TEXT_WEIGHTS = ['400', '600', '700', '800'] as const;

/**
 * Text-overlay styling panel (#5). Reads the selected text clip's params and
 * writes each change as one reversible `set_effect_params` edit. Re-mounted per
 * clip (via `key`) so it always reflects the selected overlay's real params. The
 * program monitor shows a live styled preview of the same params.
 */
export function TextOverlayInspector({
  editor,
  clip,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
}): JSX.Element {
  const params = readTextParams(clip);
  const commit = (patch: Partial<TextOverlayParams>): void => {
    const built = setTextParamsPatch(editor.state.timeline, clip.id, patch);
    if (built) editor.applyPatch(built);
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
        <div className="inspector-color-row">
          <span className="inspector-select-caption">Color</span>
          <input
            type="color"
            aria-label="text color"
            value={params.color}
            onChange={(event) => commit({ color: event.target.value })}
          />
        </div>
        <LabeledSelect
          caption="Font"
          label="font family"
          value={params.fontFamily}
          options={TEXT_FONTS}
          onChange={(value) => commit({ fontFamily: value })}
        />
        <LabeledSelect
          caption="Weight"
          label="font weight"
          value={String(params.fontWeight)}
          options={TEXT_WEIGHTS}
          onChange={(value) => commit({ fontWeight: Number(value) })}
        />
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
              value={params.background}
              onChange={(event) => commit({ background: event.target.value })}
            />
          )}
        </div>
      </div>

      <div className="inspector-subpanel" aria-label="text animation">
        <h4>Animation</h4>
        <LabeledSelect
          caption="In"
          label="in animation"
          value={params.inAnimation}
          options={TEXT_ANIMATIONS}
          onChange={(value) => commit({ inAnimation: value })}
        />
        <LabeledSelect
          caption="Out"
          label="out animation"
          value={params.outAnimation}
          options={TEXT_ANIMATIONS}
          onChange={(value) => commit({ outAnimation: value })}
        />
        <ScrubNumber
          label="Duration s"
          ariaLabel="animation duration"
          value={params.animDurationSeconds}
          min={0}
          max={3}
          step={0.05}
          onChange={(value) => commit({ animDurationSeconds: value })}
        />
      </div>
    </>
  );
}
