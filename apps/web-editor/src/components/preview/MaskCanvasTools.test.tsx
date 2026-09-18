/**
 * Monitor mask tools (MK4.1): every tool with pointer and keyboard, and the rule that a gesture
 * commits exactly one patch on release (nothing mid-drag).
 *
 * The test frame is 1920×1080 showing a 3840×2160 clip, so one frame pixel is two source pixels
 * and the canvas's client rect is pinned to the frame, making `clientX` a frame pixel.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { effectLayerMaskOwner, encodeMaskPath, maskPathVerticesAt } from '@framepilot/editor-core';
import { useEditor, type UseEditor } from '../../editor/useEditor.js';
import { MaskToolStore } from '../inspector/masks/useMaskTools.js';
import { MaskCanvasTools } from './MaskCanvasTools.js';
import { maskToolTelemetry } from './mask-tool-telemetry.js';

// AI Object and AI Brush need the Smart Mask pack, and the toolbar disables them without it
// (BR6.2). These tests are about the tools themselves, so the pack is ready here.
const bridge = vi.hoisted(() => ({
  capabilityPackStatus: vi.fn(async () => ({
    state: 'ready' as const,
    capability: 'subject.matte',
    pack: {
      id: 'smart-mask',
      version: '1.0.0',
      releaseDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      os: 'darwin' as const,
      arch: 'arm64' as const,
    },
  })),
  onCapabilityPackInstalled: vi.fn(() => () => {}),
}));

vi.mock('../../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/bridge.js')>()),
  getBridge: () => bridge,
}));

const RESOLUTION = { width: 1920, height: 1080 };
const ASSETS: Asset[] = [
  {
    id: 'a1',
    path: 'media/a1.mp4',
    kind: 'video',
    durationSeconds: 10,
    media: { width: 3840, height: 2160 },
  } as Asset,
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
            ...(masks.length > 0
              ? { masks: masks.map((mask) => MaskLayerSchema.parse(mask)) }
              : {}),
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
});

const rect: MaskLayerInput = {
  kind: 'rectangle',
  id: 'c1__mask',
  cx: 1920,
  cy: 1080,
  width: 800,
  height: 400,
};

let editor: UseEditor;
let store: MaskToolStore;

function Host({ initial }: { readonly initial: Timeline }): JSX.Element {
  editor = useEditor(initial, { assets: ASSETS });
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  return (
    <MaskCanvasTools
      editor={editor}
      clip={clip}
      assets={editor.state.assets}
      resolution={RESOLUTION}
      frameWidth={1920}
      store={store}
    />
  );
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

function drag(
  from: [number, number],
  to: [number, number],
  extra: Record<string, unknown> = {},
  steps = 4,
): void {
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
    expect(masks()[0]).toMatchObject({
      kind: 'rectangle',
      cx: 400.25,
      cy: 300.5,
      width: 400.5,
      height: 201,
    });
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
    mount(timeline([square(200, 200, 400)]));
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
    drag([rotateAt.x, rotateAt.y], [rotateAt.x + 200, rotateAt.y + 200], {
      shiftKey: true,
      altKey: true,
    });
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
    expect(
      maskPathVerticesAt(masks()[0] as PathMask, 0).map((vertex) => [vertex.x, vertex.y]),
    ).toEqual([
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
    expect(masks()[0]).toMatchObject({
      kind: 'rectangle',
      cx: 1915,
      cy: 1075,
      width: 10,
      height: 10,
    });
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Mask zoom' }), {
      target: { value: '400' },
    });
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
    expect(maskToolTelemetry.samples('commit').length).toBeGreaterThan(0);
    expect(maskToolTelemetry.samples('pointerToPaint').length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// AI Object and AI Brush (BR6.3)
// ---------------------------------------------------------------------------

describe('the AI subject tools', () => {
  it('records a click as a keep point and an Alt-click as a leave-out point', async () => {
    mount(timeline());
    await waitFor(() => expect(store.getState().tool).toBe('select'));
    act(() => store.setTool('ai-object'));

    click(960, 540);
    click(480, 270, { altKey: true });

    const picked = store.getState().subjectPoints;
    expect(picked).toHaveLength(2);
    // Fractions of the picture, which is what the pack's prompt takes.
    expect(picked[0]).toMatchObject({ x: 0.5, y: 0.5, label: 'include', sourceTime: 0 });
    expect(picked[1]).toMatchObject({ x: 0.25, y: 0.25, label: 'exclude' });
    // Picking the subject changes nothing in the project until a run produces an artifact.
    expect(historyLength()).toBe(0);
    expect(masks()).toHaveLength(0);
  });

  it('takes a click on an existing point back instead of stacking a second one', async () => {
    mount(timeline());
    act(() => store.setTool('ai-object'));
    click(960, 540);
    click(960, 540);
    expect(store.getState().subjectPoints).toHaveLength(0);
  });

  it('samples a brush stroke into evenly spaced points rather than one per move', async () => {
    mount(timeline());
    act(() => store.setTool('ai-brush'));

    // 200 source pixels of stroke, sampled 50 times: 4 source pixels between moves.
    drag([400, 540], [500, 540], {}, 50);

    const picked = store.getState().subjectPoints;
    expect(picked.length).toBeGreaterThan(1);
    // At 24 source pixels apart, 200 pixels of stroke is ~9 points, not one per move.
    expect(picked.length).toBeLessThanOrEqual(10);
    expect(picked.every((point) => point.label === 'include')).toBe(true);
    expect(historyLength()).toBe(0);
  });

  it('marks an Alt-drag as leave-out', async () => {
    mount(timeline());
    act(() => store.setTool('ai-brush'));
    drag([400, 540], [900, 540], { altKey: true }, 10);
    expect(store.getState().subjectPoints.every((point) => point.label === 'exclude')).toBe(true);
  });

  it('picks the subject from the keyboard and clears with Escape', async () => {
    mount(timeline());
    act(() => store.setTool('ai-object'));
    const target = canvas();

    fireEvent.keyDown(target, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(store.getState().subjectPoints).toHaveLength(1);
    expect(store.getState().subjectPoints[0]!.label).toBe('include');

    // Shift+Enter on the same spot is a correction, not a second pick: it flips the meaning.
    fireEvent.keyDown(target, { key: 'Enter', shiftKey: true });
    expect(store.getState().subjectPoints).toHaveLength(1);
    expect(store.getState().subjectPoints[0]!.label).toBe('exclude');

    for (let step = 0; step < 20; step += 1) {
      fireEvent.keyDown(target, { key: 'ArrowDown', shiftKey: true });
    }
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(store.getState().subjectPoints).toHaveLength(2);

    fireEvent.keyDown(target, { key: 'Escape' });
    expect(store.getState().subjectPoints).toHaveLength(0);
  });

  it('tints the object a click would select, and adds nothing until the click (BR6.11)', async () => {
    const segment = vi.fn(async (intent: { hoverPoint?: { x: number; y: number } }) => ({
      ok: true as const,
      pts: 0,
      width: 4,
      height: 2,
      mask: Uint8Array.from([0, 255, 255, 0, 0, 255, 255, 0]),
      score: 0.9,
      point: intent.hoverPoint,
    }));
    (bridge as Record<string, unknown>).matteSegmentFrame = segment;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,AAAA',
    );
    try {
      mount(timeline());
      await waitFor(() => expect(store.getState().tool).toBe('select'));
      act(() => store.setTool('ai-object'));
      await waitFor(() =>
        expect(screen.getByLabelText('AI Object tool')).not.toHaveProperty('disabled', true),
      );
      fireEvent.pointerMove(canvas(), at(960, 540));
      await waitFor(() => expect(segment).toHaveBeenCalled());
      // Picture fractions of the pointer, for the clip's asset at the source instant on screen.
      expect(segment.mock.calls[0]![0]).toMatchObject({
        assetId: 'a1',
        sourceTime: 0,
        hoverPoint: { x: 0.5, y: 0.5 },
        previewHeight: 360,
      });
      const tint = await screen.findByTestId('subject-hover-object');
      expect(tint.querySelector('image')?.getAttribute('href')).toBe('data:image/png;base64,AAAA');
      expect(tint.querySelector('rect')?.getAttribute('mask')).toMatch(/^url\(#subject-hover-/u);
      // Hovering is not editing.
      expect(historyLength()).toBe(0);
      expect(store.getState().subjectPoints).toHaveLength(0);
      fireEvent.pointerLeave(canvas());
      await waitFor(() => expect(screen.queryByTestId('subject-hover-object')).toBeNull());
      // AI Brush keeps the ring only: the tint is AI Object's.
      act(() => store.setTool('ai-brush'));
      segment.mockClear();
      fireEvent.pointerMove(canvas(), at(400, 300));
      expect(segment).not.toHaveBeenCalled();
    } finally {
      delete (bridge as Record<string, unknown>).matteSegmentFrame;
    }
  });

  it('keeps the AI tools in the toolbar, disabled, when the pack is missing', async () => {
    bridge.capabilityPackStatus.mockResolvedValueOnce({
      state: 'missing',
      capability: 'subject.matte',
      proposal: { ok: false, code: 'offline', error: 'no catalog' },
    } as never);
    mount(timeline());

    const button = await screen.findByRole('button', { name: 'AI Object tool' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    // Visible, not hidden: an editor must be able to see the capability exists.
    expect(screen.getByRole('button', { name: 'AI Brush tool' })).toBeTruthy();
  });
});

describe('analytic mask tools (MK8.1)', () => {
  it('Split: one drag places the line and commits one mask; its handles then rotate it', () => {
    mount(timeline());
    fireEvent.click(screen.getByRole('button', { name: 'Split tool' }));
    drag([960, 540], [1060, 540]);
    expect(historyLength()).toBe(1);
    expect(masks()[0]).toMatchObject({
      kind: 'linear',
      originX: 1920,
      originY: 1080,
      angle: 0,
      name: 'Split 1',
    });
    expect(store.getState()).toMatchObject({ tool: 'select', selectedMaskId: 'c1__mask' });
    // The angle handle sits along the line; dragging it straight down turns the split to 90°.
    const handle = canvas().querySelector('[data-handle="rotate"]')!;
    const hx = Number(handle.getAttribute('x')) + Number(handle.getAttribute('width')) / 2;
    const hy = Number(handle.getAttribute('y')) + Number(handle.getAttribute('height')) / 2;
    drag([hx / 2, hy / 2], [960, 740]);
    expect(historyLength()).toBe(2);
    expect(masks()[0]).toMatchObject({ kind: 'linear', angle: 90 });
    act(() => editor.undo());
    expect(masks()[0]).toMatchObject({ angle: 0 });
  });

  it('Mirror and Gradient: a band a quarter of the picture wide, a radial ramp on Alt-drag', () => {
    mount(timeline());
    act(() => store.setTool('mirror'));
    drag([960, 540], [960, 540], {}, 1);
    expect(masks()[0]).toMatchObject({ kind: 'band', widthPx: 540 });
    act(() => store.setTool('gradient'));
    drag([100, 100], [400, 100], { altKey: true });
    expect(masks()[0]).toMatchObject({
      kind: 'gradient',
      shape: 'radial',
      startX: 200,
      startY: 200,
      endX: 800,
      endY: 200,
    });
    act(() => store.setTool('gradient'));
    click(50, 50);
    expect(store.getState().message).toMatch(/Drag from where the gradient/);
    expect(historyLength()).toBe(2);
  });

  it('dragging a split line moves it; arrows nudge it; Delete removes it', () => {
    mount(timeline([{ kind: 'linear', id: 'c1__mask', originX: 1920, originY: 1080, angle: 0 }]));
    act(() => store.selectMask('c1__mask'));
    drag([700, 540], [700, 600]);
    expect(masks()[0]).toMatchObject({ originX: 1920, originY: 1200 });
    fireEvent.keyDown(canvas(), { key: 'ArrowRight' });
    expect(masks()[0]).toMatchObject({ originX: 1921 });
    fireEvent.keyDown(canvas(), { key: 'Delete' });
    expect(masks()).toHaveLength(0);
  });
});

describe('shape presets (MK8.3)', () => {
  it('Shapes: pick a preset, drag a box, get an ordinary editable path in one undo', () => {
    mount(timeline());
    fireEvent.click(screen.getByRole('button', { name: 'Shape preset tool' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Shape preset' }), {
      target: { value: 'star' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Star points' }), {
      target: { value: '6' },
    });
    const target = canvas();
    fireEvent.pointerDown(target, at(100, 100));
    fireEvent.pointerMove(target, at(300, 300));
    expect(screen.getAllByTestId('mask-preset-draft')).toHaveLength(1);
    expect(historyLength()).toBe(0);
    fireEvent.pointerUp(target, at(300, 300));
    expect(historyLength()).toBe(1);
    const star = masks()[0] as PathMask;
    expect(star).toMatchObject({ kind: 'path', name: 'Star' });
    expect(maskPathVerticesAt(star, 0)).toHaveLength(12);
    expect(store.getState()).toMatchObject({ tool: 'select', selectedMaskId: 'c1__mask' });
    act(() => editor.undo());
    expect(masks()).toHaveLength(0);
  });

  it('a rounded frame is an outer path and a subtracted inner one', () => {
    mount(timeline());
    act(() => store.update({ tool: 'shape', shapePreset: 'rounded-frame' }));
    drag([100, 100], [500, 400]);
    expect(masks().map((mask) => [mask.kind, mask.mode])).toEqual([
      ['path', 'add'],
      ['path', 'subtract'],
    ]);
    expect(historyLength()).toBe(1);
  });
});

describe('adjustment lane (MK9.1)', () => {
  function laneTimeline(): Timeline {
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
              start: 2,
              end: 6,
              params: { radius: 8 },
              keyframes: [],
            },
          ],
        },
      ],
    } as unknown as Timeline;
  }

  function LaneHost(): JSX.Element {
    editor = useEditor(laneTimeline(), { assets: [] });
    const layer = editor.state.timeline.tracks[0]!.effectLayers![0]!;
    return (
      <MaskCanvasTools
        editor={editor}
        clip={effectLayerMaskOwner(layer)}
        assets={editor.state.assets}
        resolution={RESOLUTION}
        frameWidth={1920}
        store={store}
        owner="effect_layer"
      />
    );
  }

  const laneMasks = (): readonly MaskLayer[] =>
    masksOf(editor.state.timeline.tracks[0]!.effectLayers![0]!);

  it('draws in output-frame pixels onto the lane, one undoable patch', () => {
    render(<LaneHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle tool' }));
    drag([100, 100], [300.5, 200]);
    expect(historyLength()).toBe(1);
    expect(laneMasks()[0]).toMatchObject({
      kind: 'rectangle',
      space: 'frame',
      cx: 200.25,
      cy: 150,
      width: 200.5,
      height: 100,
    });
    act(() => editor.undo());
    expect(laneMasks()).toHaveLength(0);
  });

  it('leaves the picture tools (AI subject, tracking hints) out of the toolbar', () => {
    render(<LaneHost />);
    expect(screen.queryByRole('button', { name: 'AI Object tool' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Feature point tool' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Split tool' })).toBeTruthy();
  });
});
