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

const UNIT_LABEL: Readonly<Record<string, string | undefined>> = {
  'share of size': undefined,
  'share of frame height': undefined,
  degrees: '°',
  'share dimmed': undefined,
};

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
  const setLoop = (preset: LoopPreset, periodSeconds: number, amount: number, reason: string) =>
    apply({ loop: { preset, periodSeconds, amount } }, reason);

  return (
    <div className="inspector-subpanel animation-section" aria-label="animation">
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
      {loop !== null && loopInfo !== null && (
        <>
          <MaskNumberField
            label="Speed"
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
            value={loop.amount}
            min={loopInfo.amount.min}
            max={loopInfo.amount.max}
            step={loopInfo.amountUnit === 'degrees' ? 1 : 0.01}
            {...(UNIT_LABEL[loopInfo.amountUnit] === undefined
              ? {}
              : { unit: UNIT_LABEL[loopInfo.amountUnit]! })}
            onCommit={(amount) => setLoop(loop.preset, loop.periodSeconds, amount, 'Loop amount')}
          />
          {!loop.coversClip && (
            <p className="inspector-note" role="note">
              The clip is longer than its loop.{' '}
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
      {refusal !== null && (
        <p className="inspector-note" role="status">
          {refusal}
        </p>
      )}
    </div>
  );
}
