/**
 * The toolbar's keyframe control, as its own subscribing component.
 *
 * ## Why it is not just markup inside `Toolbar`
 *
 * Whether this control adds or removes — and whether it is available at all —
 * depends on the playhead, which moves ~60×/s during playback. `Toolbar` is
 * deliberately memoised OUT of the per-seek render path (perf slice 1b): it reads
 * `editor.getPlayhead()` only inside handlers, never during render, so a seek does
 * not re-render the whole bar.
 *
 * Reading the playhead during `Toolbar`'s render to decide this control's state
 * would break that contract in one of two ways — either the toolbar re-renders on
 * every frame of playback, or (worse, and what happened first) it does not, and the
 * control silently goes stale: it keeps saying "Add keyframe" while the playhead
 * sits on one, and stays enabled after the playhead leaves the clip.
 *
 * So the subscription lives here, in the smallest component that needs it. The
 * button re-renders on a seek; nothing else on the bar does.
 *
 * The playhead is quantised to frames for the SUBSCRIPTION only — that bounds how
 * often this re-renders — while the intent itself is computed from the exact
 * `getPlayhead()`, so the decision is never a frame out at a keyframe's edge.
 */
import { useSyncExternalStore } from 'react';
import { Button } from '@framepilot/ui';
import type { Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../editor/useEditor.js';
import { findClip } from '../../editor/selectors.js';
import { removeKeyframesPatch, setKeyframesForClipsPatch } from '../../editor/patch-builders.js';
import { Tooltip, TooltipInfo } from '../Tooltip.js';
import { MenuItem } from '../Menu.js';
import { Diamond, ICON_SIZE } from '../icons.js';
import { selectionKeyframeIntent, type SelectionKeyframeIntent } from './clip-keyframe-toggle.js';

/** Re-render granularity for the subscription (30fps is finer than the eye needs). */
const SUBSCRIBE_FPS = 30;

interface KeyframeControl {
  readonly intent: SelectionKeyframeIntent;
  readonly toggle: () => void;
}

/** The live intent for the whole selection, plus the action that commits it. */
function useKeyframeControl(
  editor: UseEditor,
  timeline: Timeline,
  selectedIds: readonly string[],
): KeyframeControl {
  // Subscribe for the re-render; the value itself is only a frame counter.
  useSyncExternalStore(
    editor.subscribePlayhead,
    () => Math.floor(editor.getPlayhead() * SUBSCRIBE_FPS),
    () => 0,
  );

  // Every selected clip, not just the primary one — `duplicate` already treats a
  // multi-selection as the thing the user is acting on, and keyframing four
  // selected clips is one action that should cost one press of undo.
  const clips = selectedIds
    .map((id) => findClip(timeline, id)?.clip)
    .filter((clip): clip is NonNullable<typeof clip> => clip !== undefined);
  const intent = selectionKeyframeIntent(clips, editor.getPlayhead());

  const toggle = (): void => {
    if (intent.kind === 'none') return;
    const patch =
      intent.kind === 'remove'
        ? removeKeyframesPatch(
            timeline,
            intent.plans.flatMap((plan) =>
              plan.intent.kind === 'remove' ? plan.intent.removals : [],
            ),
          )
        : setKeyframesForClipsPatch(
            timeline,
            intent.plans.map((plan) => ({
              clipId: plan.clipId,
              // A clip already holding a keyframe here re-records it; the write is
              // replace-mode, so that is idempotent rather than duplicating.
              writes: plan.intent.kind === 'add' ? plan.intent.writes : [],
              time: plan.clipTime,
            })),
          );
    if (patch) editor.applyPatch(patch);
  };

  return { intent, toggle };
}

export interface KeyframeToolbarControlProps {
  readonly editor: UseEditor;
  readonly timeline: Timeline;
  /** The whole selection; the control acts on every clip the playhead is inside. */
  readonly selectedIds: readonly string[];
}

/** The icon button, for the expanded toolbar. */
export function KeyframeToolbarButton({
  editor,
  timeline,
  selectedIds,
}: KeyframeToolbarControlProps): JSX.Element {
  const { intent, toggle } = useKeyframeControl(editor, timeline, selectedIds);
  const removing = intent.kind === 'remove';
  return (
    <Tooltip
      label={
        <TooltipInfo term={removing ? 'Remove keyframe' : 'Add keyframe at playhead'}>
          {removing
            ? 'Removes the keyframe sitting under the playhead, so the clip stops holding a pose there.'
            : 'Records how the clip looks right now — position, scale, rotation and opacity — at the playhead, so it can change between here and the next keyframe. It does not move the picture; it pins what is already on screen. Once a clip is animated, this only touches the properties it already animates.'}
        </TooltipInfo>
      }
    >
      <Button
        variant="ghost"
        className={`icon-btn${removing ? ' is-active' : ''}`}
        type="button"
        aria-label={removing ? 'Remove keyframe' : 'Add keyframe'}
        aria-pressed={removing}
        onClick={toggle}
        disabled={intent.kind === 'none'}
      >
        <Diamond size={ICON_SIZE.sm} aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}

/**
 * The same action as a row in the `⋯ More` menu.
 *
 * The clip-actions group folds into that menu below a threshold, and an action that
 * simply disappears at a narrow window is not an action — the fold exists to keep
 * things reachable, not to drop them.
 */
export function KeyframeMenuItem({
  editor,
  timeline,
  selectedIds,
  onSelected,
}: KeyframeToolbarControlProps & { readonly onSelected: () => void }): JSX.Element {
  const { intent, toggle } = useKeyframeControl(editor, timeline, selectedIds);
  return (
    <MenuItem
      icon={<Diamond size={ICON_SIZE.sm} aria-hidden="true" />}
      disabled={intent.kind === 'none'}
      onSelect={() => {
        toggle();
        onSelected();
      }}
    >
      {intent.kind === 'remove' ? 'Remove keyframe' : 'Add keyframe'}
    </MenuItem>
  );
}
