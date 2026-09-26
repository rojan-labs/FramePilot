/**
 * The Inspector's Animation section for stickers, shapes and titles (plan/elements EL7.1, 02 §4):
 * **In** and **Out**, each a preset and a length, and **Loop**, a preset with its speed and how far
 * it moves. Every change is one undoable edit built by editor-core's `planElementAnimation`, the
 * builder the assistant's `set_element_animation` uses, so the two can never disagree.
 *
 * A loop is keyframes over the clip as it was when the loop was set (ADR 0192): after the clip is
 * lengthened the section offers **Re-apply**, which writes the loop again over the whole clip.
 */
import { useState } from 'react';
import {
  ANIMATION_KINDS,
  LOOP_PRESETS,
  LOOP_PRESET_INFO,
  clipAnimation,
  planElementAnimation,
  type AnimationKind,
  type ElementAnimationRequest,
  type LoopPreset,
  type LoopPresetInfo,
} from '@framepilot/editor-core';
import type { Clip } from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';
import type { UseEditor } from '../../../editor/useEditor.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { MaskNumberField } from '../masks/MaskNumberField.js';

const log = createLogger('web-editor:element-animation');

const NONE = 'none';
const EDGE_KINDS = Object.values(ANIMATION_KINDS);
/** A transition set elsewhere (a cut's, or a catalogue kind outside the curated set). */
const OTHER = 'other';
/** The longest In or Out the length field offers; the op holds it to half the clip anyway. */
const MAX_EDGE_SECONDS = 3;

/**
 * How the Amount field reads for each kind of loop. A share (of the clip's size, of the frame's
 * height, of its opacity) is shown as a percentage — 0.02 of the frame height reads "2 % of
 * height" — while what is stored, and what the assistant's tool takes, stays the share.
 */
const AMOUNT_DISPLAY: Readonly<
  Record<LoopPresetInfo['amountUnit'], { readonly scale: number; readonly unit: string }>
> = {
  'share of size': { scale: 100, unit: '%' },
  'share of frame height': { scale: 100, unit: '% of height' },
  'share dimmed': { scale: 100, unit: '%' },
  degrees: { scale: 1, unit: '°' },
};
/** One step of a percentage field: a tenth of a percent; a degree for the rotating loops. */
const PERCENT_STEP = 0.1;
const DEGREE_STEP = 1;

export interface AnimationInspectorProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  /** The export frame, which a float or bounce loop moves a share of. */
  readonly resolution: { readonly width: number; readonly height: number };
}

export function AnimationInspector({
  editor,
  clip,
  resolution,
}: AnimationInspectorProps): JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null);
  const animation = clipAnimation(clip);

  const apply = (request: ElementAnimationRequest, reason: string): void => {
    const plan = planElementAnimation(editor.state.timeline, clip.id, request, resolution);
    if (!plan.ok) {
      setRefusal(plan.detail);
      return;
    }
    setRefusal(null);
    const issues = editor.applyPatchChecked({
      patchId: `animate_${clip.id}_${String(Date.now())}` as never,
      createdBy: 'user',
      reason,
      operations: [...plan.operations],
    });
    if (issues.length > 0) {
      log.warn('animation refused by the validator', { issues: issues.length });
      setRefusal(issues[0]!.message);
    }
  };

  const edgeRow = (edge: 'in' | 'out', caption: string) => {
    const current = animation[edge];
    const value = current === null ? NONE : (current.kind ?? OTHER);
    const options = [
      NONE,
      ...EDGE_KINDS.map((spec) => spec.id),
      ...(value === OTHER ? [OTHER] : []),
    ];
    const labels = [
      'None',
      ...EDGE_KINDS.map((spec) => spec.label),
      ...(value === OTHER ? ['Other (set in Transitions)'] : []),
    ];
    return (
      <>
        <LabeledSelect
          caption={caption}
          label={`${caption} animation`}
          value={value}
          options={options}
          labels={labels}
          onChange={(next) => {
            if (next === OTHER || next === value) return;
            apply(
              { [edge]: next === NONE ? null : { kind: next as AnimationKind } },
              next === NONE ? `Remove ${caption.toLowerCase()} animation` : `Animate ${caption}`,
            );
          }}
        />
        {current !== null && current.kind !== null && (
          <MaskNumberField
            label="Length"
            name={`${caption} duration`}
            value={current.seconds}
            min={0.05}
            max={MAX_EDGE_SECONDS}
            step={0.05}
            unit="s"
            onCommit={(seconds) =>
              apply({ [edge]: { kind: current.kind!, seconds } }, `${caption} animation length`)
            }
          />
        )}
      </>
    );
  };

  const loop = animation.loop;
  const loopInfo = loop === null ? null : LOOP_PRESET_INFO[loop.preset];
  const amountDisplay = loopInfo === null ? null : AMOUNT_DISPLAY[loopInfo.amountUnit];
  const setLoop = (preset: LoopPreset, periodSeconds: number, amount: number, reason: string) =>
    apply({ loop: { preset, periodSeconds, amount } }, reason);

  return (
    <div className="inspector-subpanel animation-section" role="group" aria-label="animation">
      {edgeRow('in', 'In')}
      {edgeRow('out', 'Out')}
      <LabeledSelect
        caption="Loop"
        label="Loop animation"
        value={loop === null ? NONE : loop.preset}
        options={[NONE, ...LOOP_PRESETS]}
        labels={['None', ...LOOP_PRESETS.map((preset) => LOOP_PRESET_INFO[preset].label)]}
        onChange={(next) => {
          if (next === (loop?.preset ?? NONE)) return;
          apply(
            { loop: next === NONE ? null : { preset: next as LoopPreset } },
            next === NONE ? 'Remove loop' : 'Loop animation',
          );
        }}
      />
      {loop !== null && loopInfo !== null && amountDisplay !== null && (
        <>
          {/* A period, named as one: seconds per cycle, so a bigger number is a slower loop
              ("Speed" read the other way round). */}
          <MaskNumberField
            label="Cycle"
            name="Loop period"
            value={loop.periodSeconds}
            min={loopInfo.period.min}
            max={loopInfo.period.max}
            step={0.1}
            unit="s"
            onCommit={(period) => setLoop(loop.preset, period, loop.amount, 'Loop speed')}
          />
          <MaskNumberField
            label="Amount"
            name="Loop amount"
            value={loop.amount * amountDisplay.scale}
            min={loopInfo.amount.min * amountDisplay.scale}
            max={loopInfo.amount.max * amountDisplay.scale}
            step={amountDisplay.scale === 1 ? DEGREE_STEP : PERCENT_STEP}
            unit={amountDisplay.unit}
            onCommit={(shown) =>
              setLoop(loop.preset, loop.periodSeconds, shown / amountDisplay.scale, 'Loop amount')
            }
          />
          {!loop.coversClip && (
            <p className="inspector-note" role="note">
              The loop stops before the clip ends.{' '}
              <button
                type="button"
                className="animation-reapply"
                aria-label="Re-apply the loop"
                onClick={() =>
                  setLoop(loop.preset, loop.periodSeconds, loop.amount, 'Re-apply loop')
                }
              >
                Re-apply
              </button>
            </p>
          )}
        </>
      )}
      {/* Mounted empty, so the region is there before it has anything to say. */}
      <p className="inspector-note live-slot" role="status">
        {refusal ?? ''}
      </p>
    </div>
  );
}
