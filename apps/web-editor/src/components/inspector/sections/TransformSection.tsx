/**
 * Transform & motion section body (revamp Phase 5, F5).
 *
 * ## What was here before
 *
 * Not what F5 described. The diagnosis says "the actual scale field sits in the same
 * panel above" — it did not. This section had **no transform fields at all**: a
 * read-only `<li>` dump of every keyframe, a punch-in form, and an add-keyframe form
 * with a property dropdown. There was nowhere in the inspector to see or set a clip's
 * scale, position, rotation or opacity; the only way to reach them was to drag on the
 * canvas. So fixing F5 is not "put a diamond next to the existing field" — the fields
 * had to be built.
 *
 * ## The rule these rows obey
 *
 * A property that is not animated has a **base value** (a keyframe at time 0, which
 * is what the canvas handles write). A property that *is* animated has a **curve**.
 *
 *  - Editing a non-animated property moves the base and starts no animation — the
 *    playhead is irrelevant. Anything else would mean that scrubbing somewhere and
 *    nudging scale silently animated the clip.
 *  - Editing an animated property writes a keyframe **at the playhead**, and the row
 *    warns that it will (`+kf`) before the user commits.
 *
 * That is the same contract After Effects states with its stopwatch, and it is
 * enforced in one place — `keyframe-state.ts`'s `willCreateKeyframe`.
 *
 * ## Only what the render honours
 *
 * The five rows are exactly `evaluate_clip_transform`'s properties. Volume is not
 * here: audio gain is an effect param, not a keyframed property, so a diamond on it
 * would animate nothing in the export.
 */
import { useState } from 'react';
import { Button } from '@framepilot/ui';
import type { Clip } from '@framepilot/timeline-schema';
import type { Easing } from '@framepilot/editor-core';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  EASINGS,
  punchInPatch,
  removeKeyframePatch,
  setClipTransformPatch,
  setKeyframeAtPlayheadPatch,
  setKeyframeEasingPatch,
  setKeyframeHandlesPatch,
} from '../../../editor/patch-builders.js';
import { ScrubNumber } from '../../ScrubNumber.js';
import { InspectorRow } from '../InspectorRow.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { KeyframeButton } from '../KeyframeButton.js';
import { KeyframeGraphEditor } from '../../timeline/KeyframeGraphEditor.js';
import { useKeyframeState } from '../useKeyframeState.js';
import {
  ANIMATABLE_DEFAULTS,
  type AnimatableProperty,
  animatedProperties,
  displayValue,
} from '../keyframe-state.js';

const DEFAULT_FROM_SCALE = 1;
const DEFAULT_TO_SCALE = 1.2;

/** Display metadata per animatable property. Ranges match the canvas handles'. */
interface PropertyRow {
  readonly property: AnimatableProperty;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string;
}

const ROWS: readonly PropertyRow[] = [
  { property: 'scale', label: 'Scale', min: 0.05, max: 8, step: 0.01 },
  // Project pixels from centred, matching `setClipTransformPatch`'s convention. The
  // range is generous on purpose: pushing a clip fully off-frame is a legitimate move
  // (a slide-out), so the field must not stop at the frame edge.
  { property: 'x', label: 'X', min: -4000, max: 4000, step: 1, unit: 'px' },
  { property: 'y', label: 'Y', min: -4000, max: 4000, step: 1, unit: 'px' },
  // Degrees, ANTICLOCKWISE-positive — the project/MoviePy convention. Beyond ±360 is
  // allowed because a multi-turn spin is a real animation, not a mistake.
  { property: 'rotation', label: 'Rotation', min: -1440, max: 1440, step: 1, unit: '°' },
  { property: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
];

/** One property row: value field + keyframe diamond, wired to the rules above. */
function TransformRow({
  editor,
  clip,
  row,
  clipTime,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly row: PropertyRow;
  readonly clipTime: number;
}): JSX.Element {
  const state = useKeyframeState(clip.keyframes, row.property, clipTime);
  const base = ANIMATABLE_DEFAULTS[row.property];
  const value = displayValue(state, baseValueOf(clip, row.property, base));

  const commit = (next: number): void => {
    // The one branch that makes the section's contract real: a static property moves
    // its base, an animated one writes at the playhead. (When the playhead is at the
    // clip's start these are the same write — time 0 — which is why the base case
    // needs no special-casing for it.)
    const patch =
      state.status === 'none'
        ? setClipTransformPatch(editor.state.timeline, clip.id, { [row.property]: next })
        : setKeyframeAtPlayheadPatch(editor.state.timeline, clip.id, row.property, next, clipTime);
    if (patch) editor.applyPatch(patch);
  };

  const toggleKeyframe = (): void => {
    const patch =
      state.status === 'at-playhead'
        ? removeKeyframePatch(editor.state.timeline, clip.id, row.property, clipTime)
        : // Starting (or extending) an animation pins the CURRENT value at the
          // playhead, so clicking the diamond never changes the picture — it only
          // records where it is now.
          setKeyframeAtPlayheadPatch(editor.state.timeline, clip.id, row.property, value, clipTime);
    if (patch) editor.applyPatch(patch);
  };

  // The curve controls belong to ONE keyframe, so they appear only when the playhead
  // is standing on one — which is also the only moment "this keyframe's curve" is an
  // unambiguous phrase. Rendering a graph under all five rows at once would be five
  // graphs for keyframes the user is not looking at.
  const curve =
    state.atPlayhead !== undefined ? (
      <KeyframeGraphEditor
        keyframe={state.atPlayhead}
        // The segment runs INTO the next keyframe, whose `in` handle shapes its far
        // end (ADR 0089's two-sided convention).
        next={state.points.find((point) => point.time > state.atPlayhead!.time) ?? null}
        onEasingChange={(easing) => {
          const patch = setKeyframeEasingPatch(
            editor.state.timeline,
            clip.id,
            row.property,
            state.atPlayhead!.time,
            easing,
          );
          if (patch) editor.applyPatch(patch);
        }}
        onHandlesChange={(handles) => {
          // A curve drag writes BOTH control points, but they live on two different
          // keyframes — this keyframe's `out` and the next one's `in` — so it is two
          // patches' worth of intent. Merged into one so a drag is one undo step.
          const following = state.points.find((point) => point.time > state.atPlayhead!.time);
          const first = setKeyframeHandlesPatch(
            editor.state.timeline,
            clip.id,
            row.property,
            state.atPlayhead!.time,
            handles === null
              ? null
              : { out: handles.out, in: state.atPlayhead!.handles?.in ?? handles.out },
          );
          const second =
            following && handles !== null
              ? setKeyframeHandlesPatch(
                  editor.state.timeline,
                  clip.id,
                  row.property,
                  following.time,
                  { out: following.handles?.out ?? handles.in, in: handles.in },
                )
              : null;
          const operations = [...(first?.operations ?? []), ...(second?.operations ?? [])];
          if (operations.length === 0) return;
          editor.applyPatch({
            patchId: `kfcurve_${clip.id}_${row.property}` as never,
            createdBy: 'user',
            reason: first?.reason ?? second!.reason,
            operations,
          });
        }}
      />
    ) : null;

  return (
    <>
      <InspectorRow
        label={row.label}
        name={row.property}
        onReset={() => {
          // Clearing every keyframe for the property IS the reset, in one patch. The
          // base value is itself stored as a time-0 keyframe, and a property with no
          // keyframes evaluates to its identity — so removing them returns both the
          // base and the animation to default. Writing an identity keyframe afterwards
          // would be a redundant second undo step that stores a value meaning "none".
          const patch = removeKeyframePatch(editor.state.timeline, clip.id, row.property);
          if (patch) editor.applyPatch(patch);
        }}
        canReset={value !== base || state.points.length > 0}
        keyframe={
          <KeyframeButton
            state={state}
            label={row.label.toLowerCase()}
            onToggle={toggleKeyframe}
            // Clip-relative → timeline seconds. The chevrons seek; they never edit.
            onSeek={(time) => editor.seek(clip.start + time)}
          />
        }
      >
        <ScrubNumber
          label={row.label}
          ariaLabel={row.property}
          value={value}
          min={row.min}
          max={row.max}
          step={row.step}
          {...(row.unit !== undefined ? { unit: row.unit } : {})}
          // Deliberately NOT `defaultValue`: ScrubNumber renders its own reset with the
          // same accessible name as the row's, and the two do different things — the
          // field's would restore the value and leave the animation in place, so the
          // property would spring back as soon as the playhead moved. One reset per
          // row, and it is the one that knows about keyframes.
          onChange={commit}
        />
      </InspectorRow>
      {curve}
    </>
  );
}

/** A property's base (time-0) value, or `fallback` when it has no keyframes. */
function baseValueOf(clip: Clip, property: string, fallback: number): number {
  const atZero = clip.keyframes.find(
    (keyframe) => keyframe.property === property && keyframe.time === 0,
  );
  return atZero?.value ?? fallback;
}

export function TransformPanel({
  editor,
  clip,
  clipTime,
}: {
  readonly editor: UseEditor;
  readonly clip: Clip;
  /** The playhead, already converted to clip-relative seconds and clamped. */
  readonly clipTime: number;
}): JSX.Element {
  const [fromScale, setFromScale] = useState(DEFAULT_FROM_SCALE);
  const [toScale, setToScale] = useState(DEFAULT_TO_SCALE);
  const [punchEasing, setPunchEasing] = useState<Easing>('ease-in-out');

  const animated = animatedProperties(clip.keyframes);

  return (
    <>
      {ROWS.map((row) => (
        <TransformRow
          // Keyed by clip so switching selection re-seeds the fields rather than
          // showing the previous clip's values for a frame.
          key={`${clip.id}-${row.property}`}
          editor={editor}
          clip={clip}
          row={row}
          clipTime={clipTime}
        />
      ))}

      {/* The clip-level "this is animated" fact, stated once. Phase 6 turns the same
          list into timeline lanes; here it is the answer to "what is moving?" without
          reading five diamonds. */}
      {animated.length > 0 && (
        <p className="inspector-animated-summary" aria-label="animated properties">
          Animated: {animated.join(', ')}
        </p>
      )}

      <div className="inspector-subpanel" aria-label="punch-in">
        <h4>Punch-in (zoom)</h4>
        <ScrubNumber
          label="From"
          ariaLabel="from scale"
          value={fromScale}
          min={0.1}
          max={4}
          step={0.05}
          onChange={setFromScale}
        />
        <ScrubNumber
          label="To"
          ariaLabel="to scale"
          value={toScale}
          min={0.1}
          max={4}
          step={0.05}
          onChange={setToScale}
        />
        <LabeledSelect
          caption="Easing"
          label="punch easing"
          value={punchEasing}
          options={EASINGS}
          onChange={(value) => setPunchEasing(value as Easing)}
        />
        <Button
          variant="secondary"
          type="button"
          onClick={() => {
            const patch = punchInPatch(
              editor.state.timeline,
              clip.id,
              fromScale,
              toScale,
              punchEasing,
            );
            if (patch) editor.applyPatch(patch);
          }}
          disabled={toScale === fromScale}
        >
          Add punch-in
        </Button>
      </div>
    </>
  );
}
