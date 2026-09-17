/**
 * The Inspector's Effects tab for a clip: one row per effect instance, each with "Add mask"
 * (MK5.1, plan 10 "Editing tools" → Effects).
 *
 * WHY a button rather than a menu: limiting an effect to a region is the ordinary way a face
 * blur, a sky grade or a spot fix is made, and in Premiere and Resolve it is one click from the
 * effect itself. The button arms the next drawn shape with this effect as its target and opens
 * the drawing tool; the mask is created by the same `draw_mask` command the hand tools use, so
 * there is one undo step and no invented bounds (MK4.4 deleted the hardcoded ones).
 */
import { masksOf, type Clip, type Effect } from '@framepilot/timeline-schema';
import { ICON_SIZE, Scan } from '../../icons.js';

/** How an effect's row names it: the instance's type, which is what the schema stores. */
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
}

export function ClipEffectList({
  clip,
  onAddMask,
  canAddMask,
  cannotAddReason,
}: ClipEffectListProps): JSX.Element {
  const masks = masksOf(clip);
  if (clip.effects.length === 0) {
    return <p className="inspector-empty inspector-empty-inline">No clip effects applied.</p>;
  }
  return (
    <ul className="inspector-effect-list">
      {clip.effects.map((effect) => {
        const limiting = masks.filter(
          (mask) => mask.target.kind === 'effect' && mask.target.effectId === effect.id,
        );
        return (
          <li key={effect.id}>
            <span>{effectRowLabel(effect)}</span>
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
          </li>
        );
      })}
    </ul>
  );
}
