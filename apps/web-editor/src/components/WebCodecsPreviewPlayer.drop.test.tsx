/**
 * The program monitor as a drop target (plan/elements EL11, 02 §3): a sticker or shape tile let go
 * over the picture is handed to the host with where on the frame it landed — measured against the
 * displayed frame's own box, so a letterboxed 9:16 project in a 16:9 monitor maps into the picture,
 * not the monitor. Only the layer compositor's monitor takes drops, and only stickers and shapes:
 * photos, videos and bin assets on the monitor are deferred.
 *
 * jsdom has no `DragEvent` or `DataTransfer`, so each drag event is built with the fields a browser
 * gives it (`clientX`/`clientY`, and a `dataTransfer` whose `types` are readable during dragover
 * and whose data is readable on drop).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import type { MonitorDropItem } from '../editor/monitor-drop.js';
import type { FramePoint } from '../preview/frame-point.js';
import { ASSET_DND_TYPE } from './MediaBin.js';
import {
  ELEMENT_DND_TYPE,
  elementKindDndType,
  encodeElementDrag,
  type ElementDragPayload,
} from './elements/element-dnd.js';
import { WebCodecsPreviewPlayer } from './WebCodecsPreviewPlayer.js';

const compositorFlag = vi.hoisted(() => ({ layers: true }));
vi.mock('../preview/compositor-flag.js', () => ({
  layerCompositorEnabled: () => compositorFlag.layers,
}));

/** A vertical short. */
const RESOLUTION = { width: 1080, height: 1920 };

/** Its picture as a 1600 × 900 monitor shows it: pillarboxed, 506.25 px wide, centred. */
const FRAME = { left: 546.875, top: 0, width: 506.25, height: 900 };

const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};
const assets = [{ id: 'a', path: 'blob:a', kind: 'video' as const, durationSeconds: 4 }];

type OnDrop = (item: MonitorDropItem, point: FramePoint) => void;

function Host({ onDropElement }: { readonly onDropElement?: OnDrop }): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  return (
    <SettingsProvider>
      <WebCodecsPreviewPlayer
        editor={editor}
        assets={assets}
        fps={30}
        aspect={RESOLUTION.width / RESOLUTION.height}
        resolution={RESOLUTION}
        {...(onDropElement ? { onDropElement } : {})}
      />
    </SettingsProvider>
  );
}

/** The monitor, its frame laid out as {@link FRAME} inside the stage's letterbox. */
interface Mounted {
  /** The black around the picture, the monitor's drop zone. */
  readonly stage: HTMLElement;
  /** The picture: where the ring shows, and the box a drop is measured against. */
  readonly frame: HTMLElement;
}

function mount(onDropElement?: OnDrop): Mounted {
  const { container } = render(<Host {...(onDropElement ? { onDropElement } : {})} />);
  const stage = container.querySelector<HTMLElement>('.preview-stage')!;
  const frame = container.querySelector<HTMLElement>('.preview-frame')!;
  frame.getBoundingClientRect = () =>
    ({ ...FRAME, x: FRAME.left, y: FRAME.top, right: 1053.125, bottom: 900 }) as DOMRect;
  return { stage, frame };
}

/** A tile's drag as the browser carries it: the payload and its kind, as the tile wrote them. */
function tileDrag(payload: ElementDragPayload): Map<string, string> {
  return new Map([
    [ELEMENT_DND_TYPE, encodeElementDrag(payload)],
    [elementKindDndType(payload.kind), payload.kind],
  ]);
}

/**
 * Fire one drag event at `target` — the innermost element under the pointer, as a browser does —
 * with a pointer position and a drag's data; returns whether the monitor took it (the default was
 * prevented) and the drop effect it set.
 */
function drag(
  type: 'dragEnter' | 'dragOver' | 'drop' | 'dragLeave',
  target: Element,
  data: ReadonlyMap<string, string>,
  at: { readonly x: number; readonly y: number },
): { readonly taken: boolean; readonly dropEffect: string } {
  const dataTransfer = {
    types: [...data.keys()],
    dropEffect: 'none',
    getData: (format: string) => data.get(format) ?? '',
  };
  const event = createEvent[type](target, { dataTransfer });
  Object.defineProperties(event, { clientX: { value: at.x }, clientY: { value: at.y } });
  const notPrevented = fireEvent(target, event);
  return { taken: !notPrevented, dropEffect: dataTransfer.dropEffect };
}

/** A quarter of the way across the picture, three quarters down. */
const QUARTER = { x: FRAME.left + FRAME.width / 4, y: FRAME.height * 0.75 };

beforeEach(() => {
  compositorFlag.layers = true;
});

describe('program monitor — dropping a sticker or shape on the picture', () => {
  it('takes a shape let go over the picture, and says where on the frame it landed', () => {
    const onDropElement = vi.fn<OnDrop>();
    const { frame } = mount(onDropElement);
    const shape = tileDrag({ kind: 'shape', presetId: 'rounded-rect/highlight', colour: null });

    expect(drag('dragEnter', frame, shape, QUARTER).taken).toBe(true);
    expect(drag('dragOver', frame, shape, QUARTER)).toEqual({ taken: true, dropEffect: 'copy' });
    // The picture shows it is where the drop will land while the tile is over the monitor.
    expect(frame.classList.contains('is-element-drop')).toBe(true);
    expect(drag('drop', frame, shape, QUARTER).taken).toBe(true);
    expect(frame.classList.contains('is-element-drop')).toBe(false);

    // Into the picture: a quarter across the 9:16 frame, not a quarter across the monitor.
    expect(onDropElement).toHaveBeenCalledOnce();
    expect(onDropElement).toHaveBeenCalledWith(
      { kind: 'shape', presetId: 'rounded-rect/highlight', colour: null },
      { x: 0.25, y: 0.75 },
    );
  });

  it('takes a sticker let go over something drawn on the picture', () => {
    const onDropElement = vi.fn<OnDrop>();
    const { frame } = mount(onDropElement);
    const sticker = tileDrag({ kind: 'sticker', elementId: 'fire' });
    const drawn = frame.firstElementChild!;
    drag('dragOver', drawn, sticker, QUARTER);
    drag('drop', drawn, sticker, QUARTER);
    expect(onDropElement).toHaveBeenCalledWith(
      { kind: 'sticker', elementId: 'fire' },
      { x: 0.25, y: 0.75 },
    );
  });

  it('lands a drop in the letterbox on the picture’s nearest edge', () => {
    const onDropElement = vi.fn<OnDrop>();
    const { stage, frame } = mount(onDropElement);
    const sticker = tileDrag({ kind: 'sticker', elementId: 'fire' });
    // The black left of the pillarboxed picture, halfway down: the stage, not the frame.
    expect(drag('dragOver', stage, sticker, { x: 100, y: 450 }).taken).toBe(true);
    expect(frame.classList.contains('is-element-drop')).toBe(true);
    drag('drop', stage, sticker, { x: 100, y: 450 });
    // And right of it, a quarter of the way down.
    drag('dragOver', stage, sticker, { x: 1500, y: 225 });
    drag('drop', stage, sticker, { x: 1500, y: 225 });
    expect(onDropElement.mock.calls.map(([, point]) => point)).toEqual([
      { x: 0, y: 0.5 },
      { x: 1, y: 0.25 },
    ]);
  });

  it('does not take photos, videos or bin assets: they are not offered on the monitor yet', () => {
    const onDropElement = vi.fn<OnDrop>();
    const { stage, frame } = mount(onDropElement);
    const photo = tileDrag({ kind: 'stock', mediaKind: 'photo', remoteId: '2014422' });
    expect(drag('dragEnter', frame, photo, QUARTER).taken).toBe(false);
    expect(drag('dragOver', frame, photo, QUARTER).taken).toBe(false);
    expect(frame.classList.contains('is-element-drop')).toBe(false);
    drag('drop', frame, photo, QUARTER);
    const binAsset = new Map([[ASSET_DND_TYPE, 'cam']]);
    expect(drag('dragOver', stage, binAsset, QUARTER).taken).toBe(false);
    drag('drop', stage, binAsset, QUARTER);
    // A drag that claims a shape but carries something else is read, and refused, on drop.
    const forged = new Map([
      [ELEMENT_DND_TYPE, encodeElementDrag({ kind: 'stock', mediaKind: 'video', remoteId: '1' })],
      [elementKindDndType('shape'), 'shape'],
    ]);
    drag('drop', frame, forged, QUARTER);
    expect(onDropElement).not.toHaveBeenCalled();
  });

  it('keeps its ring while the drag crosses what is on the monitor, and drops it on leaving', () => {
    const { stage, frame } = mount(vi.fn<OnDrop>());
    const shape = tileDrag({ kind: 'shape', presetId: 'ellipse/outline', colour: null });
    const drawn = frame.firstElementChild!;
    // Into the letterbox, then onto the picture, then onto something drawn on it: each enter
    // comes before the leave of what it left, as a browser orders them.
    drag('dragEnter', stage, shape, { x: 100, y: 450 });
    drag('dragEnter', frame, shape, QUARTER);
    drag('dragLeave', stage, shape, QUARTER);
    drag('dragEnter', drawn, shape, QUARTER);
    drag('dragLeave', frame, shape, QUARTER);
    expect(frame.classList.contains('is-element-drop')).toBe(true);
    // Back out through the picture and the letterbox, and off the monitor.
    drag('dragEnter', stage, shape, { x: 100, y: 450 });
    drag('dragLeave', drawn, shape, { x: 100, y: 450 });
    expect(frame.classList.contains('is-element-drop')).toBe(true);
    drag('dragLeave', stage, shape, { x: 2000, y: 450 });
    expect(frame.classList.contains('is-element-drop')).toBe(false);
  });

  it('is not a drop target on the legacy monitor, nor without a host to place the drop', () => {
    const shape = tileDrag({ kind: 'shape', presetId: 'rounded-rect/highlight', colour: null });
    const withoutHost = mount();
    expect(drag('dragOver', withoutHost.stage, shape, QUARTER).taken).toBe(false);
    expect(drag('dragOver', withoutHost.frame, shape, QUARTER).taken).toBe(false);
    document.body.innerHTML = '';

    compositorFlag.layers = false;
    const onDropElement = vi.fn<OnDrop>();
    const legacy = mount(onDropElement);
    expect(drag('dragOver', legacy.frame, shape, QUARTER).taken).toBe(false);
    drag('drop', legacy.frame, shape, QUARTER);
    expect(onDropElement).not.toHaveBeenCalled();
  });
});
