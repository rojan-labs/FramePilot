/**
 * The Inspector's Mask tab (MK4.2, plan 05 "Placement"): the clip's mask stack and the selected
 * mask's properties.
 *
 * While this panel is open for a clip, the program monitor shows the mask tools for that clip
 * (the panel publishes `panelClipId` to the shared tool store). Shapes are drawn on the monitor;
 * the tool buttons here pick the tool and move focus to the monitor canvas, so the keyboard
 * drawing path starts from the panel.
 */
import { useEffect } from 'react';
import {
  MEASURE_MEDIA_FIRST,
  assetDisplaySize,
  nextMaskId,
  syntheticClipKind,
} from '@framepilot/editor-core';
import { masksOf, type Clip } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  clipSourceTimeAt,
  copyMasks,
  runMaskCommand,
  type MaskCommandInput,
} from '../../../editor/mask-editing.js';
import { Circle, ICON_SIZE, Pencil, PenTool, Square } from '../../icons.js';
import { BackgroundRemovalRow } from './BackgroundRemovalRow.js';
import { EdgeStylePanel } from './EdgeStylePanel.js';
import { MaskList, maskDisplayName } from './MaskList.js';
import { MaskReviewPanel } from './MaskReviewPanel.js';
import { MaskPresets } from './MaskPresets.js';
import { MaskProperties } from './MaskProperties.js';
import { TrackMatteRow } from './TrackMatteRow.js';
import { maskToolStore, useMaskTools, type MaskTool, type MaskToolStore } from './useMaskTools.js';

const DRAW_TOOLS: readonly {
  readonly tool: MaskTool;
  readonly label: string;
  readonly Icon: typeof Square;
}[] = [
  { tool: 'rectangle', label: 'Rectangle', Icon: Square },
  { tool: 'ellipse', label: 'Ellipse', Icon: Circle },
  { tool: 'pen', label: 'Pen', Icon: PenTool },
  { tool: 'freehand', label: 'Freehand', Icon: Pencil },
];

/** What a title can take in the Mask tab, instead of asking for media it does not have. */
const TITLE_MASKS_NOTE =
  'Drawing a mask needs a video or a photo. A title takes a track matte, below, or an edge style.';

export interface MaskPanelProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly store?: MaskToolStore;
}

export function MaskPanel({ editor, clip, store = maskToolStore }: MaskPanelProps): JSX.Element {
  const tools = useMaskTools(store);
  const masks = masksOf(clip);
  const sourceTime = clipSourceTimeAt(clip, editor.state.playhead);
  const media = editor.state.assets.find((asset) => asset.id === clip.assetId)?.media;
  const measured = assetDisplaySize(media) !== null;
  // A title has no picture of its own to draw on (EL2b): it takes a track matte or an edge style.
  const isTitle = syntheticClipKind(clip.assetId) === 'text';

  useEffect(() => {
    store.update({ panelClipId: clip.id });
    return () => {
      if (store.getState().panelClipId === clip.id) {
        store.update({ panelClipId: null, live: null, liveScalars: null, message: null });
      }
    };
  }, [clip.id, store]);

  // Keep a selection on this clip, as the monitor does.
  useEffect(() => {
    const stack = masksOf(clip);
    if (!stack.some((mask) => mask.id === tools.selectedMaskId))
      store.selectMask(stack[0]?.id ?? null);
  }, [clip, store, tools.selectedMaskId]);

  const selectedIndex = masks.findIndex((mask) => mask.id === tools.selectedMaskId);
  const selected = selectedIndex >= 0 ? masks[selectedIndex]! : null;

  const run = (command: MaskCommandInput): void => {
    store.update({ message: runMaskCommand(editor, command) });
  };

  const pickTool = (tool: MaskTool): void => {
    store.setTool(tool);
    // Keyboard users continue on the canvas: arrows move the crosshair, Space places points.
    document.querySelector<SVGSVGElement>('.mask-canvas')?.focus({ preventScroll: true });
  };

  return (
    <div className="inspector-subpanel mask-panel" aria-label="mask stack">
      {/* The Mask tab's first action row (plan 05 "Placement"): the preset that adds an AI
          subject matte, and the front door to every pack-backed tool's warnings. */}
      <BackgroundRemovalRow editor={editor} clip={clip} store={store} />
      <div className="mask-panel-tools" role="group" aria-label="Draw a mask">
        {DRAW_TOOLS.map(({ tool, label, Icon }) => (
          <button
            key={tool}
            type="button"
            className="mask-panel-tool"
            aria-label={`Draw ${label.toLowerCase()} mask`}
            aria-pressed={tools.tool === tool}
            disabled={!measured}
            onClick={() => pickTool(tool)}
          >
            <Icon size={ICON_SIZE.sm} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
      {!measured && !isTitle && (
        <p role="alert" className="inspector-empty inspector-empty-inline">
          {MEASURE_MEDIA_FIRST}
        </p>
      )}
      {isTitle && (
        <p role="status" className="inspector-empty inspector-empty-inline">
          {TITLE_MASKS_NOTE}
        </p>
      )}
      {/* MK8.2: a title, a graphic or another shot as this clip's mask (text as a mask). */}
      <TrackMatteRow
        timeline={editor.state.timeline}
        clip={clip}
        onAdd={(source, channel) => {
          const id = nextMaskId(clip);
          const refusal = runMaskCommand(editor, {
            type: 'add_track_matte',
            clipId: clip.id,
            source,
            channel,
          });
          store.update({ message: refusal });
          if (refusal === null) store.selectMask(id);
        }}
      />
      <MaskList
        masks={masks}
        selectedMaskId={tools.selectedMaskId}
        onSelect={(maskId) => store.selectMask(maskId)}
        onChange={(maskId, changes) =>
          run({ type: 'set_mask_properties', clipId: clip.id, maskId, sourceTime, changes })
        }
        onReorder={(maskIds) => run({ type: 'reorder_masks', clipId: clip.id, maskIds })}
        onRemove={(maskId) => run({ type: 'remove_mask', clipId: clip.id, maskId })}
      />
      <div className="mask-panel-actions" role="group" aria-label="Mask clipboard">
        <button
          type="button"
          className="inspector-text-button"
          disabled={selected === null}
          onClick={() => {
            const copied = copyMasks(
              clip,
              editor.state.assets,
              selected === null ? [] : [selected.id],
            );
            if (typeof copied === 'string') store.update({ message: copied });
            else store.update({ clipboard: copied, message: 'Mask copied.' });
          }}
        >
          Copy mask
        </button>
        <button
          type="button"
          className="inspector-text-button"
          disabled={tools.clipboard === null || !measured}
          onClick={() => {
            if (tools.clipboard === null) return;
            run({ type: 'paste_masks', clipId: clip.id, clipboard: tools.clipboard });
          }}
        >
          Paste masks
        </button>
        <button
          type="button"
          className="inspector-text-button"
          disabled={selected === null}
          onClick={() => {
            if (selected !== null)
              run({ type: 'duplicate_mask', clipId: clip.id, maskId: selected.id });
          }}
        >
          Duplicate mask
        </button>
      </div>
      {/* MK9.2: the outline, glow and shadow around what the stack keeps. */}
      <EdgeStylePanel editor={editor} clip={clip} />
      <MaskPresets
        presets={editor.state.timeline.maskPresets ?? []}
        canSave={selected !== null}
        canApply={measured}
        onSave={(name) => {
          if (selected !== null) {
            run({ type: 'save_mask_preset', clipId: clip.id, name, maskIds: [selected.id] });
          }
        }}
        onApply={(presetId) => run({ type: 'apply_mask_preset', clipId: clip.id, presetId })}
        onRemove={(presetId) => run({ type: 'remove_mask_preset', clipId: clip.id, presetId })}
      />
      {tools.message !== null && (
        <p className="inspector-empty inspector-empty-inline mask-panel-message" role="status">
          {tools.message}
        </p>
      )}
      {selected?.kind === 'matte' && (
        <MaskReviewPanel
          key={`${selected.id}-review`}
          editor={editor}
          clip={clip}
          mask={selected}
          subject="matte"
          store={store}
        />
      )}
      {selected !== null && (
        <MaskProperties
          key={selected.id}
          editor={editor}
          clip={clip}
          mask={selected}
          name={maskDisplayName(selected, selectedIndex)}
          sourceTime={sourceTime}
          store={store}
        />
      )}
    </div>
  );
}
