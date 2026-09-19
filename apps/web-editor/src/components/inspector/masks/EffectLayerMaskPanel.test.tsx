/**
 * An adjustment lane's Mask tab (MK9.1): the lane's frame-space stack is listed and edited with
 * the clip panel's own controls, each change one undoable command compiled onto the LANE.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  masksOf,
  type EffectLayer,
  type MaskLayer,
  type MaskLayerInput,
  type Timeline,
} from '@framepilot/timeline-schema';
import { useEditor, type UseEditor } from '../../../editor/useEditor.js';
import { EffectLayerMaskPanel } from './EffectLayerMaskPanel.js';
import { MaskToolStore } from './useMaskTools.js';

function timeline(masks: MaskLayerInput[]): Timeline {
  return {
    revision: 0,
    tracks: [
      {
        id: 'fx',
        type: 'effect',
        clips: [],
        effectLayers: [
          {
            id: 'lane',
            effectId: 'soft-veil',
            kind: 'blur-gaussian',
            start: 1,
            end: 5,
            params: { radius: 8 },
            keyframes: [],
            ...(masks.length > 0
              ? { masks: masks.map((mask) => MaskLayerSchema.parse({ ...mask, space: 'frame' })) }
              : {}),
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

const rect = (over: Partial<MaskLayerInput> = {}): MaskLayerInput =>
  ({
    kind: 'rectangle',
    id: 'lane__mask',
    name: 'Sky',
    cx: 960,
    cy: 200,
    width: 1920,
    height: 400,
    ...over,
  }) as MaskLayerInput;

let editor: UseEditor;
let store: MaskToolStore;

const lane = (): EffectLayer => editor.state.timeline.tracks[0]!.effectLayers![0]!;
const masks = (): readonly MaskLayer[] => masksOf(lane());

function Host({ initial }: { readonly initial: Timeline }): JSX.Element {
  editor = useEditor(initial, { assets: [] });
  return <EffectLayerMaskPanel editor={editor} layer={lane()} store={store} />;
}

beforeEach(() => {
  store = new MaskToolStore();
});

describe('effect layer mask panel', () => {
  it('opens the monitor tools for the lane and closes them on unmount', () => {
    const { unmount } = render(<Host initial={timeline([rect()])} />);
    expect(store.getState().panelClipId).toBe('lane');
    expect(store.getState().selectedMaskId).toBe('lane__mask');
    unmount();
    expect(store.getState().panelClipId).toBeNull();
  });

  it('offers geometry tools only, enabled with no media to measure', () => {
    render(<Host initial={timeline([])} />);
    const split = screen.getByRole('button', { name: 'Draw split mask' }) as HTMLButtonElement;
    expect(split.disabled).toBe(false);
    fireEvent.click(split);
    expect(store.getState().tool).toBe('split');
    expect(screen.queryByRole('button', { name: /background/i })).toBeNull();
  });

  it('edits the lane mask as one undoable command, fixed to the frame', () => {
    render(<Host initial={timeline([rect()])} />);
    const before = editor.history.entries.length;
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Sky outer feather' }), {
      target: { value: '24' },
    });
    expect(masks()[0]).toMatchObject({ featherOuterPx: 24, space: 'frame' });
    expect(editor.history.entries.length).toBe(before + 1);
    // A lane's mask always limits the whole adjustment: no per-effect target to pick.
    expect(screen.queryByRole('combobox', { name: 'Sky target' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Invert Sky' }));
    expect(masks()[0]).toMatchObject({ invert: true });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate mask' }));
    expect(masks()).toHaveLength(2);
    expect(masks().every((mask) => mask.space === 'frame')).toBe(true);
  });
});
