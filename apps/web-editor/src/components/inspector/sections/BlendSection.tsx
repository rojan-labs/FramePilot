/**
 * Blend-mode section body (revamp Phase 4 — extracted from the monolithic
 * Inspector). Title/label/order/open state live in the registry.
 */
import type { BlendMode, Clip } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import { BLEND_MODES, clipBlendMode } from '../../../editor/selectors.js';
import { setClipBlendModePatch } from '../../../editor/patch-builders.js';
import { LabeledSelect } from '../LabeledSelect.js';

/**
 * Blend-mode panel (H1.2h) — a single dropdown of the engine's 12 compositing
 * modes, committed via `set_clip_blend_mode`. Applies instantly on change (no
 * Apply button), mirroring `TransitionPanel`'s kind-swap convention: a
 * single-value dropdown that directly reflects a persisted enum, not a
 * multi-field numeric edit.
 */
export function BlendModePanel({
  editor,
  clip,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
}): JSX.Element {
  const mode = clipBlendMode(clip);
  const setMode = (next: BlendMode): void => {
    const patch = setClipBlendModePatch(
      editor.state.timeline,
      clip.id,
      next === 'normal' ? null : next,
    );
    if (patch) editor.applyPatch(patch);
  };

  return (
    <>
      <div className="inspector-subpanel" aria-label="clip blend mode">
        <LabeledSelect
          caption="Mode"
          label="blend mode"
          value={mode}
          options={BLEND_MODES}
          onChange={setMode}
        />
      </div>
    </>
  );
}
