/**
 * MK4.6 pointer-to-paint budget (plan 06: ≤ 16 ms p95 editing a 200-vertex path on 4K footage),
 * read from the monitor's own telemetry (`mask-tool-telemetry.ts`).
 *
 * jsdom has no compositor, so the animation frame that paints is stubbed to run as soon as the
 * overlay has committed: what is measured is everything the monitor does between a pointer
 * event and a paintable DOM (gesture math, snapping against the other points, the store update,
 * the React commit of the 200-point outline and its handles). jsdom is slower than a browser at
 * all of those; the Playwright spec (`mask-tools.spec.ts`) measures the same channel in Chrome.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaskLayerSchema, type Asset, type Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../../editor/useEditor.js';
import { MaskToolStore } from '../inspector/masks/useMaskTools.js';
import { MaskCanvasTools } from './MaskCanvasTools.js';
import { maskToolTelemetry } from './mask-tool-telemetry.js';

const POINTER_TO_PAINT_BUDGET_MS = 16;

/**
 * Under coverage instrumentation the timing is not the product's; the run keeps a coarse ceiling
 * and the budget itself is asserted by the uninstrumented CI step "MK4.6 budgets".
 */
const INSTRUMENTED =
  (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } })
    .__vitest_worker__?.config?.coverage?.enabled === true;
const INSTRUMENTED_CEILING_MS = 200;
const MOVES = INSTRUMENTED ? 60 : 240;
const VERTICES = 200;
const RESOLUTION = { width: 3840, height: 2160 };

const assets: Asset[] = [
  {
    id: 'a',
    path: 'a.mov',
    kind: 'video',
    durationSeconds: 10,
    media: { width: 3840, height: 2160 },
  } as Asset,
];

function timeline(): Timeline {
  const points: number[] = [];
  for (let vertex = 0; vertex < VERTICES; vertex += 1) {
    const angle = (vertex / VERTICES) * Math.PI * 2;
    points.push(1920 + 900 * Math.cos(angle), 1080 + 700 * Math.sin(angle), 0, 0, 0, 0);
  }
  return {
    revision: 0,
    tracks: [
      {
        id: 'v',
        type: 'video',
        clips: [
          {
            id: 'c',
            assetId: 'a',
            trackId: 'v',
            start: 0,
            end: 10,
            sourceStart: 0,
            sourceEnd: 10,
            effects: [],
            keyframes: [],
            masks: [
              MaskLayerSchema.parse({
                kind: 'path',
                id: 'm',
                pathKeyframes: [
                  { id: 'p', sourceTime: 0, points, vertexTypes: new Array(VERTICES).fill(0) },
                ],
              }),
            ],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

let store: MaskToolStore;

function Host(): JSX.Element {
  const editor = useEditor(timeline(), { assets });
  return (
    <MaskCanvasTools
      editor={editor}
      clip={editor.state.timeline.tracks[0]!.clips[0]!}
      assets={editor.state.assets}
      resolution={RESOLUTION}
      store={store}
    />
  );
}

beforeEach(() => {
  store = new MaskToolStore();
  maskToolTelemetry.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 0;
  });
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pointer-to-paint on a 200-vertex path at 4K (MK4.6)', () => {
  it(`keeps p95 within ${String(POINTER_TO_PAINT_BUDGET_MS)} ms for point drags and whole-mask moves`, () => {
    render(<Host />);
    const canvas = screen.getByRole('application', { name: 'Mask canvas' });
    // A point drag (snapping on: every move tests the other 199 points and the frame lines).
    // Vertex 0 sits at source (2820, 1080) = client (1410, 540) on the half-size canvas.
    fireEvent.pointerDown(canvas, { clientX: 1410, clientY: 540, pointerId: 1, button: 0 });
    for (let move = 1; move <= MOVES; move += 1) {
      fireEvent.pointerMove(canvas, {
        clientX: 1410 + (move % 60),
        clientY: 540 + (move % 35),
        pointerId: 1,
      });
    }
    fireEvent.pointerUp(canvas, { clientX: 1410, clientY: 560, pointerId: 1 });
    // A whole-mask move from inside the path.
    fireEvent.pointerDown(canvas, { clientX: 960, clientY: 540, pointerId: 2, button: 0 });
    for (let move = 1; move <= MOVES; move += 1) {
      fireEvent.pointerMove(canvas, {
        clientX: 960 + (move % 50),
        clientY: 540 + (move % 30),
        pointerId: 2,
      });
    }
    fireEvent.pointerUp(canvas, { clientX: 1000, clientY: 560, pointerId: 2 });

    const samples = maskToolTelemetry.samples('pointerToPaint');
    const p95 = maskToolTelemetry.p95('pointerToPaint');
    console.log(
      `MK4.6 pointer-to-paint (jsdom): p95 ${p95.toFixed(2)} ms over ${String(samples.length)} moves`,
    );
    expect(samples.length).toBeGreaterThan(MOVES);
    expect(p95).toBeLessThanOrEqual(
      INSTRUMENTED ? INSTRUMENTED_CEILING_MS : POINTER_TO_PAINT_BUDGET_MS,
    );
  }, 60_000);
});
