/**
 * The Inspector's Effects tab for a clip: one row per effect instance, each with "Add mask"
 * (MK5.1, plan 10 "Editing tools" → Effects).
 *
 * WHY a button rather than a menu: limiting an effect to a region is the ordinary way a face
 * blur, a sky grade or a spot fix is made, and in Premiere and Resolve it is one click from the
 * effect itself. The button arms the next drawn shape with this effect as its target and opens
 * the drawing tool; the mask is created by the same `draw_mask` command the hand tools use, so
 * there is one undo step and no invented bounds (MK4.4 deleted the hardcoded ones).
 *
 * "Add blur" puts the clip blur (`clip-blur.ts`) on the clip, because a blur limited to a mask is
 * the face blur and the plate blur: add the blur here, then "Add mask" on its row. Its strength
 * is edited on the row; masks limiting it stay attached because the blur keeps its id.
 */
import {
  CLIP_BLUR_EFFECT_TYPE,
  DEFAULT_CLIP_BLUR_AMOUNT,
  MAX_CLIP_BLUR_AMOUNT,
  clipBlurAmount,
} from '@framepilot/editor-core';
import { masksOf, type Clip, type Effect } from '@framepilot/timeline-schema';
import { ScrubNumber } from '../../ScrubNumber.js';
import { ICON_SIZE, Scan } from '../../icons.js';

/** The blur strength field works in whole percent of the picture's smaller side. */
const PERCENT = 100;
const MIN_BLUR_PERCENT = 1;

/**
 * How the "Add mask" button names an effect out loud.
 *
 * Spoken, not shown: the row still prints `effect.type` verbatim, because that is the string the
 * schema stores and the one an editor matches against a patch or a bug report. An underscore
 * read aloud by a screen reader is noise, so only the accessible name is softened.
 */
export function effectRowLabel(effect: Effect): string {
  return effect.type.replace(/_/gu, ' ');
}

export interface ClipEffectListProps {
  readonly clip: Clip;
  /** Arm the drawing tool for this effect and open the Mask tab. */
  readonly onAddMask: (effectId: string) => void;
  /** Whether a mask can be drawn at all (the media must be measured first). */
  readonly canAddMask: boolean;
  /** Why not, when it cannot. */
  readonly cannotAddReason?: string;
  /** Put a blur on the clip, or set its strength (a fraction of the smaller side). Absent → no blur UI. */
  readonly onSetBlur?: (amount: number) => void;
}

export function ClipEffectList({
  clip,
  onAddMask,
  canAddMask,
  cannotAddReason,
  onSetBlur,
}: ClipEffectListProps): JSX.Element {
  const masks = masksOf(clip);
  const hasBlur = clip.effects.some((effect) => effect.type === CLIP_BLUR_EFFECT_TYPE);
  const addBlur =
    onSetBlur !== undefined && !hasBlur ? (
      <button
        type="button"
        className="inspector-text-button"
        onClick={() => onSetBlur(DEFAULT_CLIP_BLUR_AMOUNT)}
      >
        Add blur
      </button>
    ) : null;
  if (clip.effects.length === 0) {
    return (
      <>
        <p className="inspector-empty inspector-empty-inline">No clip effects applied.</p>
        {addBlur}
      </>
    );
  }
  return (
    <>
      <ul className="inspector-effect-list">
        {clip.effects.map((effect) => {
          const limiting = masks.filter(
            (mask) => mask.target.kind === 'effect' && mask.target.effectId === effect.id,
          );
          return (
            <li key={effect.id}>
              <span>{effect.type}</span>
              <code title={effect.id}>{effect.id}</code>
              {limiting.length > 0 && (
                <span className="inspector-effect-masked">
                  {limiting.length === 1 ? '1 mask' : `${String(limiting.length)} masks`}
                </span>
              )}
              <button
                type="button"
                className="inspector-text-button"
                aria-label={`Add mask to ${effectRowLabel(effect)}`}
                title={canAddMask ? undefined : cannotAddReason}
                disabled={!canAddMask}
                onClick={() => onAddMask(effect.id)}
              >
                <Scan size={ICON_SIZE.sm} aria-hidden="true" />
                Add mask
              </button>
              {effect.type === CLIP_BLUR_EFFECT_TYPE && onSetBlur !== undefined && (
                <ScrubNumber
                  label="Strength"
                  ariaLabel="Blur strength"
                  unit="%"
                  min={MIN_BLUR_PERCENT}
                  max={MAX_CLIP_BLUR_AMOUNT * PERCENT}
                  value={Math.round(clipBlurAmount(effect.params) * PERCENT)}
                  defaultValue={DEFAULT_CLIP_BLUR_AMOUNT * PERCENT}
                  onChange={(percent) => onSetBlur(percent / PERCENT)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {addBlur}
    </>
  );
}
