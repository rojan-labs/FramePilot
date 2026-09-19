/**
 * The selected `key` mask's controls (MK6.1): the model, the eyedropper, the qualifier ranges,
 * softness, despill and shadow retention.
 *
 * The eyedropper is the fast path and the ranges are the tight one, which is how a colourist
 * works: pick the backing, then pull the edges in. Picking arms the monitor rather than opening
 * a colour dialog, because the colour that matters is the one in the frame.
 *
 * Every change leaves through `set_mask_properties`, so the AI's key edits and a hand edit
 * produce the same operation and the same undo step.
 */
import type { Clip, MaskLayer } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import type { MaskPropertyValue } from '@framepilot/editor-core';
import { runMaskCommand, type MaskCommandInput } from '../../../editor/mask-editing.js';
import { ICON_SIZE, Pipette } from '../../icons.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { InspectorRow } from '../InspectorRow.js';
import { MaskNumberField } from './MaskNumberField.js';
import { maskToolStore, useMaskTools, type MaskToolStore } from './useMaskTools.js';

type KeyMask = Extract<MaskLayer, { kind: 'key' }>;

const MODELS = ['hsl', 'rgb', 'luma', '3d'] as const;
const MODEL_LABELS = [
  'Hue / saturation / luma',
  'RGB channels',
  'Luma',
  'Sampled colours',
] as const;

const DESPILLS = ['none', 'green', 'blue'] as const;
const DESPILL_LABELS = ['No despill', 'Green screen', 'Blue screen'] as const;

/** Which channels each model qualifies on, in the order the panel lists them. */
const MODEL_CHANNELS: Readonly<Record<string, readonly KeyMask['ranges'][number]['channel'][]>> = {
  hsl: ['hue', 'saturation', 'luma'],
  rgb: ['red', 'green', 'blue'],
  luma: ['luma'],
  '3d': [],
};

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  hue: 'Hue',
  saturation: 'Saturation',
  luma: 'Luma',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

export interface MaskKeyControlsProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly mask: KeyMask;
  readonly name: string;
  readonly sourceTime: number;
  readonly locked: boolean;
  readonly store?: MaskToolStore;
}

export function MaskKeyControls({
  editor,
  clip,
  mask,
  name,
  sourceTime,
  locked,
  store = maskToolStore,
}: MaskKeyControlsProps): JSX.Element {
  const tools = useMaskTools(store);
  const run = (command: MaskCommandInput): void => {
    store.update({ message: runMaskCommand(editor, command) });
  };
  const change = (changes: Readonly<Record<string, MaskPropertyValue>>): void => {
    run({ type: 'set_mask_properties', clipId: clip.id, maskId: mask.id, sourceTime, changes });
  };

  const channels = MODEL_CHANNELS[mask.model] ?? [];
  const rangeOf = (channel: string): KeyMask['ranges'][number] | undefined =>
    mask.ranges.find((entry) => entry.channel === channel);

  const writeRange = (
    channel: KeyMask['ranges'][number]['channel'],
    field: 'low' | 'high' | 'softness',
    value: number,
  ): void => {
    const existing = rangeOf(channel);
    const next = mask.ranges.some((entry) => entry.channel === channel)
      ? mask.ranges.map((entry) =>
          entry.channel === channel ? { ...entry, [field]: value } : entry,
        )
      : [
          ...mask.ranges,
          { channel, low: 0, high: 1, softness: 0, ...(existing ?? {}), [field]: value },
        ];
    change({ ranges: next });
  };

  const picking = tools.eyedropper;

  return (
    <>
      <LabeledSelect
        caption="Key on"
        label={`${name} key model`}
        value={mask.model}
        options={MODELS}
        labels={MODEL_LABELS}
        onChange={(value) => change({ model: value })}
      />
      <InspectorRow label="Pick colour" name={`${name} eyedropper`}>
        <button
          type="button"
          className="inspector-text-button mask-eyedropper"
          aria-pressed={picking}
          disabled={locked}
          onClick={() => store.update({ eyedropper: !picking, message: null })}
        >
          <Pipette size={ICON_SIZE.sm} aria-hidden="true" />
          {picking ? 'Click the monitor (Shift adds)' : 'Eyedropper'}
        </button>
      </InspectorRow>
      {mask.model === '3d' ? (
        <>
          <InspectorRow label="Sampled" name={`${name} samples`}>
            <span className="inspector-row-value tabular">
              {mask.samples3d.length === 1
                ? '1 colour'
                : `${String(mask.samples3d.length)} colours`}
            </span>
          </InspectorRow>
          <MaskNumberField
            label="Tolerance"
            name={`${name} tolerance`}
            value={mask.softness}
            step={0.01}
            min={0}
            max={1}
            disabled={locked}
            onCommit={(value) => change({ softness: value })}
          />
          {mask.samples3d.length > 0 && (
            <button
              type="button"
              className="inspector-text-button"
              disabled={locked}
              onClick={() => change({ samples3d: [] })}
            >
              Clear sampled colours
            </button>
          )}
        </>
      ) : (
        <>
          {channels.map((channel) => {
            const range = rangeOf(channel);
            return (
              <div key={channel} className="mask-key-range">
                <MaskNumberField
                  label={`${CHANNEL_LABELS[channel] ?? channel} from`}
                  name={`${name} ${channel} low`}
                  value={range?.low ?? 0}
                  step={0.01}
                  min={0}
                  max={1}
                  disabled={locked}
                  onCommit={(value) => writeRange(channel, 'low', value)}
                />
                <MaskNumberField
                  label={`${CHANNEL_LABELS[channel] ?? channel} to`}
                  name={`${name} ${channel} high`}
                  value={range?.high ?? 1}
                  step={0.01}
                  min={0}
                  max={1}
                  disabled={locked}
                  onCommit={(value) => writeRange(channel, 'high', value)}
                />
                <MaskNumberField
                  label={`${CHANNEL_LABELS[channel] ?? channel} softness`}
                  name={`${name} ${channel} softness`}
                  value={range?.softness ?? 0}
                  step={0.01}
                  min={0}
                  max={1}
                  disabled={locked}
                  onCommit={(value) => writeRange(channel, 'softness', value)}
                />
              </div>
            );
          })}
          <MaskNumberField
            label="Extra softness"
            name={`${name} key softness`}
            value={mask.softness}
            step={0.01}
            min={0}
            max={1}
            disabled={locked}
            onCommit={(value) => change({ softness: value })}
          />
        </>
      )}
      <LabeledSelect
        caption="Despill"
        label={`${name} despill`}
        value={mask.despill}
        options={DESPILLS}
        labels={DESPILL_LABELS}
        onChange={(value) => change({ despill: value })}
      />
      <MaskNumberField
        label="Keep shadows"
        name={`${name} shadow retention`}
        value={mask.shadowRetention}
        step={0.01}
        min={0}
        max={1}
        disabled={locked}
        onCommit={(value) => change({ shadowRetention: value })}
      />
    </>
  );
}
