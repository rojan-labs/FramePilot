/**
 * Inspector Mask tab (MK4.2): every list control and property control, each committing one
 * mask command, plus keyframe toggles/navigation and "Apply to all keyframes".
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  masksOf,
  type Asset,
  type MaskLayer,
  type MaskLayerInput,
  type Timeline,
} from '@framepilot/timeline-schema';
import { encodeMaskPath } from '@framepilot/editor-core';
import { useEditor, type UseEditor } from '../../../editor/useEditor.js';
import { MaskPanel } from './MaskPanel.js';
import { MaskToolStore } from './useMaskTools.js';

const ASSETS: Asset[] = [
  {
    id: 'a1',
    path: 'media/a1.mp4',
    kind: 'video',
    durationSeconds: 10,
    media: { width: 1920, height: 1080 },
  } as Asset,
  { id: 'raw', path: 'media/raw.mp4', kind: 'video', durationSeconds: 10 } as Asset,
];

function timeline(masks: MaskLayerInput[], assetId = 'a1'): Timeline {
  return {
    revision: 0,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId,
            trackId: 'v1',
            start: 0,
            end: 10,
            sourceStart: 2,
            sourceEnd: 12,
            effects: [{ id: 'grade', type: 'color_grade', params: {}, keyframes: [] }],
            keyframes: [],
            ...(masks.length > 0
              ? { masks: masks.map((mask) => MaskLayerSchema.parse(mask)) }
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
    id: 'm1',
    name: 'Face',
    cx: 960,
    cy: 540,
    width: 400,
    height: 300,
    ...over,
  }) as MaskLayerInput;

let editor: UseEditor;
let store: MaskToolStore;

function Host({ initial }: { readonly initial: Timeline }): JSX.Element {
  editor = useEditor(initial, { assets: ASSETS });
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  return <MaskPanel editor={editor} clip={clip} store={store} />;
}

const masks = (): readonly MaskLayer[] => masksOf(editor.state.timeline.tracks[0]!.clips[0]!);
const history = (): number => editor.history.entries.length;

beforeEach(() => {
  store = new MaskToolStore();
});

describe('panel', () => {
  it('opens the monitor tools for its clip and closes them on unmount', () => {
    const { unmount } = render(<Host initial={timeline([rect()])} />);
    expect(store.getState().panelClipId).toBe('c1');
    expect(store.getState().selectedMaskId).toBe('m1');
    unmount();
    expect(store.getState().panelClipId).toBeNull();
  });

  it('picks a drawing tool', () => {
    render(<Host initial={timeline([])} />);
    expect(screen.getByText('No masks yet. Draw one on the monitor.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Draw ellipse mask' }));
    expect(store.getState().tool).toBe('ellipse');
  });

  it('says to measure unmeasured media and disables drawing', () => {
    render(<Host initial={timeline([], 'raw')} />);
    expect(screen.getByRole('alert').textContent).toContain('Measure this media first');
    expect(
      (screen.getByRole('button', { name: 'Draw pen mask' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('mask list', () => {
  const two = (): Timeline => timeline([rect(), rect({ id: 'm2', name: 'Sky', color: '#f97316' })]);

  it('selects with a click and arrow keys', () => {
    render(<Host initial={two()} />);
    fireEvent.click(screen.getByRole('option', { name: 'Sky' }));
    expect(store.getState().selectedMaskId).toBe('m2');
    fireEvent.keyDown(screen.getByRole('option', { name: 'Sky' }), { key: 'ArrowUp' });
    expect(store.getState().selectedMaskId).toBe('m1');
  });

  it('reorders with Alt+Arrow and by dragging, one patch each', () => {
    render(<Host initial={two()} />);
    fireEvent.keyDown(screen.getByRole('option', { name: 'Face' }), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect(masks().map((mask) => mask.id)).toEqual(['m2', 'm1']);
    fireEvent.dragStart(screen.getByRole('option', { name: 'Face' }));
    fireEvent.dragOver(screen.getByRole('option', { name: 'Sky' }));
    fireEvent.drop(screen.getByRole('option', { name: 'Sky' }));
    expect(masks().map((mask) => mask.id)).toEqual(['m1', 'm2']);
    expect(history()).toBe(2);
  });

  it('toggles visibility, lock and invert, and changes mode and colour', () => {
    render(<Host initial={two()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Face' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invert Face' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Mode of Face' }), {
      target: { value: 'subtract' },
    });
    fireEvent.change(screen.getByLabelText('Colour of Face'), { target: { value: '#22c55e' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock Face' }));
    expect(masks()[0]).toMatchObject({
      enabled: false,
      invert: true,
      mode: 'subtract',
      color: '#22c55e',
      locked: true,
    });
    // A locked mask refuses edits but can always be unlocked.
    fireEvent.click(screen.getByRole('button', { name: 'Show Face' }));
    expect(masks()[0]!.enabled).toBe(false);
    expect(store.getState().message).toMatch(/locked/i);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Face' }));
    expect(masks()[0]!.locked).toBe(false);
  });

  it('deletes a mask, undoably', () => {
    render(<Host initial={two()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sky' }));
    expect(masks().map((mask) => mask.id)).toEqual(['m1']);
    act(() => editor.undo());
    expect(masks()).toHaveLength(2);
  });
});

describe('properties', () => {
  it('commits typed px values once, on Enter, and keeps sub-pixel values', () => {
    render(<Host initial={timeline([rect()])} />);
    const width = screen.getByRole('spinbutton', { name: 'Face width' });
    fireEvent.input(width, { target: { value: '412.75' }, inputType: 'insertText' });
    fireEvent.keyDown(width, { key: 'Enter' });
    expect(masks()[0]).toMatchObject({ width: 412.75 });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Face outer feather' }), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Face expansion' }), {
      target: { value: '-4' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Face opacity' }), {
      target: { value: '0.5' },
    });
    expect(masks()[0]).toMatchObject({ featherOuterPx: 12, expansionPx: -4, opacity: 0.5 });
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Face centre x' }), {
      key: 'ArrowUp',
      shiftKey: true,
    });
    expect(masks()[0]).toMatchObject({ cx: 970 });
  });

  it('changes falloff and target', () => {
    render(<Host initial={timeline([rect()])} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Face falloff' }));
    fireEvent.click(screen.getByRole('option', { name: 'Gaussian' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Face target' }));
    fireEvent.click(screen.getByRole('option', { name: 'Effect: color_grade' }));
    expect(masks()[0]).toMatchObject({
      falloff: 'gaussian',
      target: { kind: 'effect', effectId: 'grade' },
    });
  });

  it('adds and removes a keyframe at the playhead source time and navigates between keyframes', () => {
    render(
      <Host
        initial={timeline([
          rect({ keyframes: [{ id: 'k', sourceTime: 7, property: 'cx', value: 100 }] }),
        ])}
      />,
    );
    // Playhead 0 = source second 2.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Animate Face opacity — adds a keyframe at the playhead',
      }),
    );
    expect(
      masks()[0]!.keyframes.find((keyframe) => keyframe.property === 'opacity')?.sourceTime,
    ).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'next Face centre x keyframe' }));
    expect(editor.state.playhead).toBeCloseTo(5, 6);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Face centre x keyframe at the playhead' }),
    );
    expect(masks()[0]).toMatchObject({ cx: 100 });
    expect(masks()[0]!.keyframes.some((keyframe) => keyframe.property === 'cx')).toBe(false);
  });

  it('Apply to all keyframes shifts every feather keyframe with one edit', () => {
    render(
      <Host
        initial={timeline([
          rect({
            keyframes: [
              { id: 'f0', sourceTime: 2, property: 'featherOuterPx', value: 10 },
              { id: 'f1', sourceTime: 8, property: 'featherOuterPx', value: 20 },
            ],
          }),
        ])}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Apply to all keyframes' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Face outer feather' }), {
      target: { value: '15' },
    });
    expect(history()).toBe(1);
    expect(masks()[0]!.keyframes.map((keyframe) => keyframe.value)).toEqual([15, 25]);
  });

  it('types a selected path point position and shows the path keyframe row', () => {
    const path: MaskLayerInput = {
      kind: 'path',
      id: 'm1',
      name: 'Hand',
      pathKeyframes: [
        {
          id: 'p0',
          sourceTime: 2,
          ...encodeMaskPath(
            [
              [10, 10],
              [100, 10],
              [50, 90],
            ].map(([x, y]) => ({
              x: x!,
              y: y!,
              inX: 0,
              inY: 0,
              outX: 0,
              outY: 0,
              type: 'corner' as const,
            })),
          ),
        },
      ],
    };
    render(<Host initial={timeline([path])} />);
    expect(screen.getByText('3 points')).toBeTruthy();
    act(() => store.update({ selectedVertices: [1] }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Hand point x' }), {
      target: { value: '120.5' },
    });
    const stored = masks()[0] as Extract<MaskLayer, { kind: 'path' }>;
    expect(stored.pathKeyframes[0]!.points[6]).toBe(120.5);
    fireEvent.click(
      screen.getByRole('button', { name: 'Animate Hand path — adds a keyframe at the playhead' }),
    );
    expect(store.getState().message).toMatch(/only shape/);
  });

  it('scrubbing previews live and commits one edit on release', () => {
    render(<Host initial={timeline([rect()])} />);
    const scrub = screen.getByRole('spinbutton', { name: 'Face height' }).previousElementSibling!;
    fireEvent.pointerDown(scrub, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(scrub, { clientX: 20, pointerId: 1 });
    expect(store.getState().liveScalars?.values).toEqual({ height: 320 });
    expect(history()).toBe(0);
    fireEvent.pointerUp(scrub, { clientX: 20, pointerId: 1 });
    expect(store.getState().liveScalars).toBeNull();
    expect(masks()[0]!).toMatchObject({ height: 320 });
    expect(history()).toBe(1);
  });

  it('disables fields of a locked mask', () => {
    render(<Host initial={timeline([rect({ locked: true })])} />);
    expect(screen.getByText('Locked. Unlock the mask to change it.')).toBeTruthy();
    expect(
      (screen.getByRole('spinbutton', { name: 'Face width' }) as HTMLInputElement).disabled,
    ).toBe(true);
  });
});

describe('clipboard and presets (MK4.3)', () => {
  it('copies, pastes and duplicates masks', () => {
    render(<Host initial={timeline([rect()])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy mask' }));
    expect(store.getState().clipboard?.masks).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Paste masks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate mask' }));
    expect(masks().map((mask) => mask.id)).toEqual(['c1__mask', 'm1', 'm1__paste_1']);
    expect(history()).toBe(2);
  });

  it('saves the selected mask as a project preset, applies and deletes it', () => {
    render(<Host initial={timeline([rect()])} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Preset name' }), {
      target: { value: 'Face box' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    expect(editor.state.timeline.maskPresets?.map((preset) => preset.name)).toEqual(['Face box']);
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
    expect(masks()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset' }));
    expect(editor.state.timeline.maskPresets).toBeUndefined();
    act(() => editor.undo());
    expect(editor.state.timeline.maskPresets).toHaveLength(1);
  });
});

describe('track matte (MK8.2)', () => {
  function withTitle(masks: MaskLayerInput[] = []): Timeline {
    const base = timeline(masks);
    return {
      ...base,
      tracks: [
        {
          id: 't1',
          type: 'video',
          clips: [
            {
              id: 'title',
              assetId: '__text__',
              trackId: 't1',
              start: 2,
              end: 6,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [{ id: 'tx', type: 'text', params: { text: 'SUMMER' }, keyframes: [] }],
              keyframes: [],
            },
          ],
        },
        ...base.tracks,
      ],
    } as unknown as Timeline;
  }

  it('uses a title as the mask in one undoable edit, then switches its channel', () => {
    function TitleHost({ initial }: { readonly initial: Timeline }): JSX.Element {
      editor = useEditor(initial, { assets: ASSETS });
      const clip = editor.state.timeline.tracks[1]!.clips[0]!;
      return <MaskPanel editor={editor} clip={clip} store={store} />;
    }
    render(<TitleHost initial={withTitle()} />);
    expect(screen.getByRole('combobox', { name: 'Track matte source' }).textContent).toContain(
      'Text “SUMMER” (track t1)',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use as mask' }));
    const clipMasks = () => masksOf(editor.state.timeline.tracks[1]!.clips[0]!);
    expect(clipMasks()[0]).toMatchObject({
      kind: 'layer',
      source: { kind: 'clip', clipId: 'title' },
      channel: 'alpha',
    });
    expect(editor.history.entries).toHaveLength(1);
    expect(store.getState().selectedMaskId).toBe('c1__mask');
    // The properties show the source, the channel and the edge controls, no feathers.
    expect(screen.queryByRole('spinbutton', { name: /outer feather/i })).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: /Track matte 1 track matte channel/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Luma, inverted' }));
    expect(clipMasks()[0]).toMatchObject({ channel: 'inverted-luma' });
    act(() => editor.undo());
    act(() => editor.undo());
    expect(clipMasks()).toHaveLength(0);
  });
});
