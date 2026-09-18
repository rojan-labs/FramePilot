/**
 * The Inspector's Mask tab for an ADJUSTMENT LANE (MK9.1, plan 10: "`EffectLayer` gains
 * `masks` with `space: 'frame'`, so a mask can limit an adjustment layer exactly as in Premiere
 * Pro and Resolve").
 *
 * WHY it reuses the clip panel's parts: a lane's stack is the same mask model on a different
 * owner. The lane is handed to the list, the properties and the monitor tools as a clip-shaped
 * stand-in (`effectLayerMaskOwner`: its clock is seconds from the layer's start, its picture is
 * the frame), and every edit carries `owner: 'effect_layer'` so `compileMaskCommand` puts it on
 * the lane. Drawing, reshaping, keyframing and undo therefore behave exactly as on a clip, with
 * geometry in output-frame pixels.
 *
 * While this panel is open the program monitor shows the mask tools in frame space for the lane
 * (it publishes the lane id as `panelClipId`, which no clip carries).
 */
import { useEffect, useMemo } from 'react';
import { effectLayerMaskOwner } from '@framepilot/editor-core';
import { masksOf, type EffectLayer } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  clipSourceTimeAt,
  runMaskCommand,
  type MaskCommandInput,
} from '../../../editor/mask-editing.js';
import {
  Blend,
  Circle,
  FlipVertical2,
  ICON_SIZE,
  Pencil,
  PenTool,
  Square,
  SquareSplitHorizontal,
} from '../../icons.js';
import { MaskList, maskDisplayName } from './MaskList.js';
import { MaskProperties } from './MaskProperties.js';
import { maskToolStore, useMaskTools, type MaskTool, type MaskToolStore } from './useMaskTools.js';

/** The monitor tools a lane's frame-space mask is drawn with: geometry only. */
const LANE_TOOLS: readonly {
  readonly tool: MaskTool;
  readonly label: string;
  readonly Icon: typeof Square;
}[] = [
  { tool: 'rectangle', label: 'Rectangle', Icon: Square },
  { tool: 'ellipse', label: 'Ellipse', Icon: Circle },
  { tool: 'pen', label: 'Pen', Icon: PenTool },
  { tool: 'freehand', label: 'Freehand', Icon: Pencil },
  { tool: 'split', label: 'Split', Icon: SquareSplitHorizontal },
  { tool: 'mirror', label: 'Mirror band', Icon: FlipVertical2 },
  { tool: 'gradient', label: 'Gradient', Icon: Blend },
];

export interface EffectLayerMaskPanelProps {
  readonly editor: UseEditor;
  readonly layer: EffectLayer;
  readonly store?: MaskToolStore;
}

export function EffectLayerMaskPanel({
  editor,
  layer,
  store = maskToolStore,
}: EffectLayerMaskPanelProps): JSX.Element {
  const tools = useMaskTools(store);
  const owner = useMemo(() => effectLayerMaskOwner(layer), [layer]);
  const masks = masksOf(owner);
  // Seconds from the layer's start: the lane's own mask clock.
  const localTime = clipSourceTimeAt(owner, editor.state.playhead);

  useEffect(() => {
    store.update({ panelClipId: layer.id, pendingTarget: null });
    return () => {
      if (store.getState().panelClipId === layer.id) {
        store.update({ panelClipId: null, live: null, liveScalars: null, message: null });
      }
    };
  }, [layer.id, store]);

  useEffect(() => {
    const stack = masksOf(layer);
    if (!stack.some((mask) => mask.id === tools.selectedMaskId))
      store.selectMask(stack[0]?.id ?? null);
  }, [layer, store, tools.selectedMaskId]);

  const selectedIndex = masks.findIndex((mask) => mask.id === tools.selectedMaskId);
  const selected = selectedIndex >= 0 ? masks[selectedIndex]! : null;

  const run = (command: MaskCommandInput): void => {
    store.update({ message: runMaskCommand(editor, { ...command, owner: 'effect_layer' }) });
  };

  const pickTool = (tool: MaskTool): void => {
    store.setTool(tool);
    document.querySelector<SVGSVGElement>('.mask-canvas')?.focus({ preventScroll: true });
  };

  return (
    <div className="inspector-subpanel mask-panel" aria-label="effect layer mask stack">
      <p className="inspector-empty inspector-empty-inline">
        The effect applies inside the masks. They stay fixed to the frame.
      </p>
      <div className="mask-panel-tools" role="group" aria-label="Draw a mask">
        {LANE_TOOLS.map(({ tool, label, Icon }) => (
          <button
            key={tool}
            type="button"
            className="mask-panel-tool"
            aria-label={`Draw ${label.toLowerCase()} mask`}
            aria-pressed={tools.tool === tool}
            onClick={() => pickTool(tool)}
          >
            <Icon size={ICON_SIZE.sm} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <MaskList
        masks={masks}
        selectedMaskId={tools.selectedMaskId}
        onSelect={(maskId) => store.selectMask(maskId)}
        onChange={(maskId, changes) =>
          run({
            type: 'set_mask_properties',
            clipId: layer.id,
            maskId,
            sourceTime: localTime,
            changes,
          })
        }
        onReorder={(maskIds) => run({ type: 'reorder_masks', clipId: layer.id, maskIds })}
        onRemove={(maskId) => run({ type: 'remove_mask', clipId: layer.id, maskId })}
      />
      <div className="mask-panel-actions" role="group" aria-label="Mask actions">
        <button
          type="button"
          className="inspector-text-button"
          disabled={selected === null}
          onClick={() => {
            if (selected !== null)
              run({ type: 'duplicate_mask', clipId: layer.id, maskId: selected.id });
          }}
        >
          Duplicate mask
        </button>
      </div>
      {tools.message !== null && (
        <p className="inspector-empty inspector-empty-inline mask-panel-message" role="status">
          {tools.message}
        </p>
      )}
      {selected !== null && (
        <MaskProperties
          key={selected.id}
          editor={editor}
          clip={owner}
          mask={selected}
          name={maskDisplayName(selected, selectedIndex)}
          sourceTime={localTime}
          store={store}
          owner="effect_layer"
        />
      )}
    </div>
  );
}
