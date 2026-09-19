/**
 * MK6.1: the Mask tab's `key` controls — model, eyedropper, ranges, softness, despill and
 * shadow retention — each committing one mask command.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  masksOf,
  type Asset,
  type MaskLayer,
  type MaskLayerInput,
  type Timeline,
} from '@framepilot/timeline-schema';
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
];

const key = (over: Partial<MaskLayerInput> = {}): MaskLayerInput =>
  ({
    kind: 'key',
    id: 'k1',
    name: 'Backing',
    model: 'hsl',
    ranges: [{ channel: 'hue', low: 0.25, high: 0.45, softness: 0.05 }],
    ...over,
  }) as MaskLayerInput;

function timeline(masks: MaskLayerInput[]): Timeline {
  return {
    revision: 0,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId: 'a1',
            trackId: 'v1',
            start: 0,
            end: 10,
            sourceStart: 0,
            sourceEnd: 10,
            effects: [],
            keyframes: [],
            masks: masks.map((mask) => MaskLayerSchema.parse(mask)),
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

let editor: UseEditor;
let store: MaskToolStore;

function Host({ initial }: { readonly initial: Timeline }): JSX.Element {
  editor = useEditor(initial, { assets: ASSETS });
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  return <MaskPanel editor={editor} clip={clip} store={store} />;
}

const selected = (): MaskLayer =>
  masksOf(editor.state.timeline.tracks[0]!.clips[0]!).find((mask) => mask.id === 'k1')!;

const commit = (name: string, value: string): void => {
  const field = screen.getByLabelText(name) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

/** The Inspector's dropdowns are a custom combobox: open it, then click the option. */
const choose = (combobox: string, option: string): void => {
  fireEvent.click(screen.getByRole('combobox', { name: combobox }));
  fireEvent.click(screen.getByRole('option', { name: option }));
};

beforeEach(() => {
  store = new MaskToolStore();
});

describe('key controls', () => {
  it('shows the model, the eyedropper and a range per channel of the model', () => {
    render(<Host initial={timeline([key()])} />);
    expect(screen.getByLabelText('Backing key model')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Eyedropper/ })).toBeTruthy();
    expect(screen.getByLabelText('Backing hue low')).toBeTruthy();
    expect(screen.getByLabelText('Backing saturation softness')).toBeTruthy();
    // RGB channels belong to another model and are not shown for this one.
    expect(screen.queryByLabelText('Backing red low')).toBeNull();
  });

  it('switches the model, which changes which ranges are offered', () => {
    render(<Host initial={timeline([key()])} />);
    choose('Backing key model', 'RGB channels');
    expect((selected() as Extract<MaskLayer, { kind: 'key' }>).model).toBe('rgb');
    expect(screen.getByLabelText('Backing red low')).toBeTruthy();
  });

  it('writes a range bound as one edit', () => {
    render(<Host initial={timeline([key()])} />);
    const before = editor.history.entries.length;
    commit('Backing hue high', '0.5');
    const mask = selected() as Extract<MaskLayer, { kind: 'key' }>;
    expect(mask.ranges.find((range) => range.channel === 'hue')!.high).toBe(0.5);
    expect(editor.history.entries.length).toBe(before + 1);
  });

  it('adds a range for a channel the mask did not carry yet', () => {
    render(<Host initial={timeline([key({ ranges: [] })])} />);
    commit('Backing luma low', '0.3');
    const mask = selected() as Extract<MaskLayer, { kind: 'key' }>;
    expect(mask.ranges).toEqual([{ channel: 'luma', low: 0.3, high: 1, softness: 0 }]);
  });

  it('arms and disarms the eyedropper', () => {
    render(<Host initial={timeline([key()])} />);
    const button = screen.getByRole('button', { name: /Eyedropper/ });
    fireEvent.click(button);
    expect(store.getState().eyedropper).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Click the monitor/ }));
    expect(store.getState().eyedropper).toBe(false);
  });

  it('sets despill and shadow retention', () => {
    render(<Host initial={timeline([key()])} />);
    choose('Backing despill', 'Green screen');
    expect((selected() as Extract<MaskLayer, { kind: 'key' }>).despill).toBe('green');
    commit('Backing shadow retention', '0.4');
    expect((selected() as Extract<MaskLayer, { kind: 'key' }>).shadowRetention).toBe(0.4);
  });

  it('shows sampled colours and a tolerance for the 3d model', () => {
    render(
      <Host
        initial={timeline([
          key({ model: '3d', ranges: [], samples3d: [[0, 0.7, 0.25]], softness: 0.2 }),
        ])}
      />,
    );
    expect(screen.getByText('1 colour')).toBeTruthy();
    expect(screen.getByLabelText('Backing tolerance')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear sampled colours' }));
    expect((selected() as Extract<MaskLayer, { kind: 'key' }>).samples3d).toEqual([]);
  });
});
