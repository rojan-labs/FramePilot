/**
 * Monitor mask tools (MK4.1): every tool with pointer and keyboard, and the rule that a gesture
 * commits exactly one patch on release (nothing mid-drag).
 *
 * The test frame is 1920×1080 showing a 3840×2160 clip, so one frame pixel is two source pixels
 * and the canvas's client rect is pinned to the frame, making `clientX` a frame pixel.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MaskLayerSchema,
  masksOf,
  type Asset,
  type MaskLayer,
  type MaskLayerInput,
  type PathMask,
  type Timeline,
} from '@framepilot/timeline-schema';
import { encodeMaskPath, maskPathVerticesAt } from '@framepilot/editor-core';
import { useEditor, type UseEditor } from '../../editor/useEditor.js';
import { MaskToolStore } from '../inspector/masks/useMaskTools.js';
import { MaskCanvasTools } from './MaskCanvasTools.js';
import { maskToolTelemetry } from './mask-tool-telemetry.js';

const RESOLUTION = { width: 1920, height: 1080 };
const ASSETS: Asset[] = [
  { id: 'a1', path: 'media/a1.mp4', kind: 'video', durationSeconds: 10, media: { width: 3840, height: 2160 } } as Asset,
];

function timeline(masks: MaskLayerInput[] = []): Timeline {
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
            ...(masks.length > 0 ? { masks: masks.map((mask) => MaskLayerSchema.parse(mask)) } : {}),
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

const square = (x0: number, y0: number, size: number): MaskLayerInput => ({
  kind: 'path',
  id: 'c1__mask',
  pathKeyframes: [
    {
      id: 'p0',
      sourceTime: 0,
      ...encodeMaskPath(
        [
          [x0, y0],
          [x0 + size, y0],
          [x0 + size, y0 + size],
          [x0, y0 + size],
        ].map(([x, y]) => ({ x: x!, y: y!, inX: 0, inY: 0, outX: 0, outY: 0, type: 'corner' as const })),
      ),
    },
  ],
});

const rect: MaskLayerInput = { kind: 'rectangle', id: 'c1__mask', cx: 1920, cy: 1080, width: 800, height: 400 };

let editor: UseEditor;
let store: MaskToolStore;

function Host({ initial }: { readonly initial: Timeline }): JSX.Element {
  editor = useEditor(initial, { assets: ASSETS });
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  return <MaskCanvasTools editor={editor} clip={clip} assets={editor.state.assets} resolution={RESOLUTION} frameWidth={1920} store={store} />;
}

const masks = (): readonly MaskLayer[] => masksOf(editor.state.timeline.tracks[0]!.clips[0]!);
const historyLength = (): number => editor.history.entries.length;

function canvas(): SVGSVGElement {
  return screen.getByRole('application', { name: 'Mask canvas' }) as unknown as SVGSVGElement;
}

/** Pointer at a FRAME pixel (the source pixel is twice it). */
const at = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
  clientX: x,
  clientY: y,
  pointerId: 1,
  button: 0,
  ...extra,
});

function drag(from: [number, number], to: [number, number], extra: Record<string, unknown> = {}, steps = 4): void {
  const target = canvas();
  fireEvent.pointerDown(target, at(from[0], from[1], extra));
  for (let step = 1; step <= steps; step += 1) {
    const x = from[0] + ((to[0] - from[0]) * step) / steps;
    const y = from[1] + ((to[1] - from[1]) * step) / steps;
    fireEvent.pointerMove(target, at(x, y, extra));
  }
  fireEvent.pointerUp(target, at(to[0], to[1], extra));
}

function click(x: number, y: number, extra: Record<string, unknown> = {}): void {
  fireEvent.pointerDown(canvas(), at(x, y, extra));
  fireEvent.pointerUp(canvas(), at(x, y, extra));
}

function mount(initial: Timeline): void {
  render(<Host initial={initial} />);
}

beforeEach(() => {
  store = new MaskToolStore();
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1080,
    width: 1920,
    height: 1080,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('drawing tools', () => {
  it('Rectangle: a drag previews without history and commits one mask on release, undoable', () => {
    mount(timeline());
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle tool' }));
    const target = canvas();
    fireEvent.pointerDown(target, at(100, 100));
    fireEvent.pointerMove(target, at(200, 150));
    fireEvent.pointerMove(target, at(300.25, 200.5));
    expect(historyLength()).toBe(0);
    fireEvent.pointerUp(target, at(300.25, 200.5));
    expect(historyLength()).toBe(1);
    expect(masks()[0]).toMatchObject({ kind: 'rectangle', cx: 400.25, cy: 300.5, width: 400.5, height: 201 });
    expect(store.getState()).toMatchObject({ tool: 'select', selectedMaskId: 'c1__mask' });
    act(() => editor.undo());
    expect(masks()).toHaveLength(0);
  });

  it('Ellipse: Shift draws a circle, Alt draws from the centre', () => {
    mount(timeline());
    fireEvent.click(screen.getByRole('button', { name: 'Ellipse tool' }));
    drag([500, 500], [600, 540], { shiftKey: true, altKey: true });
    expect(masks()[0]).toMatchObject({ kind: 'ellipse', cx: 1000, cy: 1000, rx: 200, ry: 200 });
  });

  it('refuses a click without a drag', () => {
    mount(timeline());
    act(() => store.setTool('rectangle'));
    click(10, 10);
    expect(historyLength()).toBe(0);
    expect(store.getState().message).toBe('Drag to draw the shape.');
  });

  it('Pen: clicks add corners, Shift constrains to 45°, clicking the first point closes', () => {
    mount(timeline());
    act(() => store.setTool('pen'));
    click(100, 100);
    click(300, 108, { shiftKey: true });
    click(300, 300);
    expect(historyLength()).toBe(0);
    click(101, 101);
    expect(historyLength()).toBe(1);
    const path = masks()[0] as PathMask;
    expect(maskPathVerticesAt(path, 0).map((vertex) => [vertex.x, vertex.y])).toEqual([
      [200, 200],
      [600, 200],
      [600, 600],
    ]);
  });

  it('Pen: dragging while placing a point pulls symmetric smooth tangents', () => {
    mount(timeline());
    act(() => store.setTool('pen'));
    drag([100, 100], [140, 100]);
    click(300, 100);
    click(200, 300);
    fireEvent.keyDown(canvas(), { key: 'Enter' });
    const [first] = maskPathVerticesAt(masks()[0] as PathMask, 0);
    expect(first).toMatchObject({ type: 'smooth', outX: 80, outY: 0, inX: -80 });
  });

  it('Freehand: a stroke becomes a smooth fitted path', () => {
    mount(timeline());
    act(() => store.setTool('freehand'));
    const target = canvas();
    fireEvent.pointerDown(target, at(600, 300));
    for (let index = 1; index <= 120; index += 1) {
      const angle = (index / 120) * Math.PI * 2;
      fireEvent.pointerMove(target, at(500 + 100 * Math.cos(angle), 300 + 100 * Math.sin(angle)));
    }
    fireEvent.pointerUp(target, at(600, 300));
    expect(historyLength()).toBe(1);
    const vertices = maskPathVerticesAt(masks()[0] as PathMask, 0);
    expect(vertices.length).toBeGreaterThanOrEqual(3);
    expect(vertices.every((vertex) => vertex.type === 'smooth')).toBe(true);
  });
});

describe('Select tool', () => {
  it('moves a mask by dragging inside it, one patch, sub-pixel', () => {
    mount(timeline([rect]));
    drag([960, 540], [970.5, 545.25], { altKey: true });
    expect(historyLength()).toBe(1);
    expect(masks()[0]).toMatchObject({ cx: 1941, cy: 1090.5 });
  });

  it('Shift constrains a move to one axis; snapping pulls to the picture centre', () => {
    mount(timeline([{ ...rect, cx: 1000, cy: 1000 }]));
    drag([500, 500], [538, 504], { shiftKey: true, altKey: true });
    expect(masks()[0]).toMatchObject({ cx: 1076, cy: 1000 });
    drag([538, 500], [958, 541]);
    expect(masks()[0]).toMatchObject({ cx: 1920, cy: 1080 });
  });

  it('drags a point, selects with a marquee and deletes the selection', () => {
    mount(timeline([{ ...square(200, 200, 400), pathKeyframes: square(200, 200, 400).kind === 'path' ? square(200, 200, 400).pathKeyframes : [] } as MaskLayerInput]));
    // Add a fifth point by clicking the top edge.
    click(200, 100);
    expect(maskPathVerticesAt(masks()[0] as PathMask, 0)).toHaveLength(5);
    drag([300, 300], [310, 305], { altKey: true });
    const moved = maskPathVerticesAt(masks()[0] as PathMask, 0);
    expect(moved.find((vertex) => vertex.x === 620 && vertex.y === 610)).toBeDefined();
    drag([50, 50], [150, 350], { altKey: true });
    expect(store.getState().selectedVertices).toEqual([0, 4]);
    fireEvent.keyDown(canvas(), { key: 'Delete' });
    expect(maskPathVerticesAt(masks()[0] as PathMask, 0)).toHaveLength(3);
  });

  it('Cmd-click converts a corner to smooth; Alt breaks a smooth tangent pair', () => {
    mount(timeline([square(200, 200, 400)]));
    click(100, 100, { metaKey: true });
    const smooth = maskPathVerticesAt(masks()[0] as PathMask, 0)[0]!;
    expect(smooth.type).toBe('smooth');
    act(() => store.update({ selectedVertices: [0] }));
    const handle = { x: (smooth.x + smooth.outX) / 2, y: (smooth.y + smooth.outY) / 2 };
    drag([handle.x, handle.y], [handle.x, handle.y + 30], { altKey: true });
    expect(maskPathVerticesAt(masks()[0] as PathMask, 0)[0]!.type).toBe('broken');
  });

  it('resizes from a corner handle and rotates with the rotation handle', () => {
    mount(timeline([rect]));
    act(() => store.update({ selectedMaskId: 'c1__mask' }));
    // South-east corner of the 800×400 box centred at (1920, 1080) is frame (1160, 640).
    drag([1160, 640], [1260, 690]);
    expect(masks()[0]).toMatchObject({ cx: 2020, cy: 1130, width: 1000, height: 500 });
    const box = masks()[0] as Extract<MaskLayer, { kind: 'rectangle' }>;
    const rotateAt = { x: box.cx / 2, y: (box.cy - box.height / 2) / 2 - 22 };
    drag([rotateAt.x, rotateAt.y], [rotateAt.x + 200, rotateAt.y + 200], { shiftKey: true, altKey: true });
    expect((masks()[0] as Extract<MaskLayer, { kind: 'rectangle' }>).rotation % 15).toBe(0);
    expect((masks()[0] as Extract<MaskLayer, { kind: 'rectangle' }>).rotation).not.toBe(0);
  });

  it('sets outer feather with its knob as one property edit', () => {
    mount(timeline([rect]));
    act(() => store.update({ selectedMaskId: 'c1__mask' }));
    const knob = document.querySelector('[data-knob="featherOuterPx"]')!;
    // Knob centres are source pixels; the pointer is in frame pixels (half).
    const x = Number(knob.getAttribute('cx')) / 2;
    const y = Number(knob.getAttribute('cy')) / 2;
    drag([x, y], [x + 15, y]);
    expect(historyLength()).toBe(1);
    expect(masks()[0]!.featherOuterPx).toBe(30);
  });

  it('nudges 1 px with arrows and 10 px with Shift', () => {
    mount(timeline([rect]));
    act(() => store.update({ selectedMaskId: 'c1__mask' }));
    fireEvent.keyDown(canvas(), { key: 'ArrowRight' });
    fireEvent.keyDown(canvas(), { key: 'ArrowDown', shiftKey: true });
    expect(masks()[0]).toMatchObject({ cx: 1921, cy: 1090 });
    expect(historyLength()).toBe(2);
  });

  it('refuses editing a locked mask', () => {
    mount(timeline([{ ...rect, locked: true }]));
    act(() => store.update({ selectedMaskId: 'c1__mask' }));
    fireEvent.keyDown(canvas(), { key: 'ArrowRight' });
    expect(historyLength()).toBe(0);
    expect(store.getState().message).toMatch(/locked/);
  });

  it('Delete with no points selected removes the mask', () => {
    mount(timeline([rect]));
    act(() => store.update({ selectedMaskId: 'c1__mask' }));
    fireEvent.keyDown(canvas(), { key: 'Backspace' });
    expect(masks()).toHaveLength(0);
  });
});

describe('keyboard drawing (a11y)', () => {
  it('draws a pen path with the crosshair: P, arrows, Space, Enter', () => {
    mount(timeline());
    const target = canvas();
    fireEvent.keyDown(target, { key: 'p' });
    expect(store.getState().tool).toBe('pen');
    fireEvent.keyDown(target, { key: ' ' });
    fireEvent.keyDown(target, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(target, { key: ' ' });
    fireEvent.keyDown(target, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(target, { key: ' ' });
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(maskPathVerticesAt(masks()[0] as PathMask, 0).map((vertex) => [vertex.x, vertex.y])).toEqual([
      [1920, 1080],
      [1930, 1080],
      [1930, 1090],
    ]);
    expect(screen.getByText('Path mask added')).toBeTruthy();
  });

  it('draws a rectangle with two Space presses and steps through points with brackets', () => {
    mount(timeline([square(200, 200, 400)]));
    const target = canvas();
    fireEvent.keyDown(target, { key: ']' });
    expect(store.getState().selectedVertices).toEqual([0]);
    fireEvent.keyDown(target, { key: '[' });
    expect(store.getState().selectedVertices).toEqual([3]);
    fireEvent.keyDown(target, { key: 'r' });
    fireEvent.keyDown(target, { key: ' ' });
    fireEvent.keyDown(target, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(target, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(target, { key: ' ' });
    expect(masks()[0]).toMatchObject({ kind: 'rectangle', cx: 1915, cy: 1075, width: 10, height: 10 });
  });

  it('Escape cancels a pen path in progress', () => {
    mount(timeline());
    const target = canvas();
    fireEvent.keyDown(target, { key: 'p' });
    fireEvent.keyDown(target, { key: ' ' });
    fireEvent.keyDown(target, { key: 'Escape' });
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(masks()).toHaveLength(0);
  });
});

describe('view', () => {
  it('draws the source pixel grid at 400% and scales the frame to source pixels', () => {
    mount(timeline([rect]));
    expect(screen.queryByTestId('mask-pixel-grid')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Mask zoom' }), { target: { value: '400' } });
    expect(screen.getByTestId('mask-pixel-grid')).toBeTruthy();
    // Fit shows one source pixel as 0.5 CSS px; 400% needs 4, so the frame scales 8×.
    expect(store.getState().frameScale).toBe(8);
  });

  it('toggles snapping from the toolbar', () => {
    mount(timeline());
    const snapping = screen.getByRole('button', { name: 'Snapping' });
    expect(snapping.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(snapping);
    expect(store.getState().snapping).toBe(false);
  });

  it('records pointer-to-paint for moves', () => {
    maskToolTelemetry.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 0;
    });
    mount(timeline([rect]));
    drag([960, 540], [980, 560], { altKey: true }, 8);
    expect(maskToolTelemetry.samples('pointerToPaint').length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
