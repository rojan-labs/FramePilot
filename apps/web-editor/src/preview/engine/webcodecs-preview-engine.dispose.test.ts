/**
 * P6.1 — what `dispose()` has to release.
 *
 * The engine is torn down on unmount, but "unmounted" is not the same as
 * "unreferenced": the `loadQueue` promise chain, an in-flight
 * `decodeAudioData`, the e2e `__fpPreviewEngine` hook and a component React has
 * not yet collected can all still point at a disposed engine. Anything the
 * engine holds at that moment stays resident for as long as one of those does —
 * which is why dispose has to release the expensive pixel state explicitly
 * instead of relying on the whole object becoming garbage.
 *
 * The state is private, so this test reads it through a cast. That is
 * deliberate: releasing a cache has no public observable, and asserting on the
 * public surface instead would assert nothing at all.
 */
import { describe, expect, it } from 'vitest';
import { WebCodecsPreviewEngine } from './webcodecs-preview-engine.js';

/** The private fields this test is about. */
interface EngineInternals {
  images: Map<string, HTMLImageElement>;
  heldFrame: { canvas: HTMLCanvasElement; forSegmentStart: number } | null;
  segments: unknown[];
  sources: Map<string, unknown>;
}

function makeEngine(): { engine: WebCodecsPreviewEngine; internals: EngineInternals } {
  // jsdom has no 2D context; the engine only needs the handle to exist.
  const canvas = {
    getContext: () => ({}) as CanvasRenderingContext2D,
    width: 1920,
    height: 1080,
  } as unknown as HTMLCanvasElement;
  const engine = new WebCodecsPreviewEngine(canvas);
  return { engine, internals: engine as unknown as EngineInternals };
}

describe('WebCodecsPreviewEngine.dispose', () => {
  it('releases the decoded still images, the held cut frame and the resolved EDL', () => {
    const { engine, internals } = makeEngine();
    internals.images.set('fp-media://photo.jpg', {} as HTMLImageElement);
    internals.sources.set('src-1', {});
    internals.heldFrame = { canvas: {} as HTMLCanvasElement, forSegmentStart: 0 };
    internals.segments = [{ projectStart: 0, projectEnd: 1 }];

    engine.dispose();

    expect(internals.images.size).toBe(0);
    expect(internals.sources.size).toBe(0);
    // A detached <canvas> reachable from a disposed engine is precisely the
    // "retained detached DOM" the phase's heap criterion rules out.
    expect(internals.heldFrame).toBeNull();
    expect(internals.segments).toHaveLength(0);
  });

  it('is idempotent — a second dispose after the state is already empty is a no-op', () => {
    const { engine, internals } = makeEngine();
    engine.dispose();
    expect(() => engine.dispose()).not.toThrow();
    expect(internals.images.size).toBe(0);
  });
});
