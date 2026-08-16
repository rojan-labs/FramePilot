/**
 * Effect layers in the DOM preview (schema v13, ADR 0088).
 *
 * WHY this exists on top of the WebCodecs path's `setEffectLayers`: there are TWO
 * preview players. The canvas engine is the default, while the `<video>`-pool
 * remains the automatic compatibility path for unsupported runtimes/media;
 * {@link PreviewPlayer} is what almost everyone actually sees. Wiring only the
 * canvas engine meant effects rendered in the export and previewed nowhere.
 *
 * HOW: a `<video>`/`<img>` element is a valid `TexImageSource`, so the SAME
 * {@link GlEffectChain} and the SAME shaders the canvas path uses can sample the
 * visible pool slot directly. There is deliberately no second effect pipeline —
 * one set of shaders, one ordering rule, one place to fix a bug.
 *
 * KNOWN DIVERGENCE, stated rather than hidden: this canvas sits above the video
 * but BELOW `.preview-overlays`, so in the DOM preview an effect covers the
 * picture and not the burned-in captions/text. The export (and the canvas
 * preview) apply effects after captions. Capturing DOM overlays into a texture
 * would need a full html-to-canvas rasterise per frame, which is not viable at
 * playback rate — so the picture-level preview is the honest trade, and a project
 * that combines captions WITH effects should be checked against the canvas
 * preview or a render.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '@framepilot/shared-types';
import { GlEffectChain, type TimedEffectLayer } from '../preview/effects/gl-effect-chain.js';
import { activeTimedItemsAt, buildTemporalIndex } from '../preview/temporal-index.js';

const log = createLogger('web-editor:preview:effect-overlay');

/**
 * One chain for the monitor, created on first use.
 *
 * Module-level and never disposed for the session, for the same reason the
 * thumbnail grid shares one: a context per mount would burn through the
 * browser's ~16-context budget as the preview remounts.
 */
let sharedChain: GlEffectChain | null = null;

function chain(): GlEffectChain {
  sharedChain ??= new GlEffectChain(() => document.createElement('canvas'));
  return sharedChain;
}

/** A source element is only sampleable once it actually holds pixels. */
function sourceReady(el: HTMLVideoElement | HTMLImageElement | null): boolean {
  if (el === null) return false;
  if (el instanceof HTMLVideoElement) {
    // HAVE_CURRENT_DATA. Uploading before this throws in some browsers and
    // yields a transparent texture in others.
    return el.readyState >= 2 && el.videoWidth > 0;
  }
  return el.complete && el.naturalWidth > 0;
}

export interface PreviewEffectOverlayProps {
  /** Every effect layer, in apply order. Filtered to the live ones per frame. */
  readonly layers: readonly TimedEffectLayer[];
  /** The element currently showing the picture. Re-read every frame — the pool swaps slots at cuts. */
  readonly getSource: () => HTMLVideoElement | HTMLImageElement | null;
  /** Live playhead, in project seconds. */
  readonly getTime: () => number;
  /** A paused monitor paints one frame and then goes idle. */
  readonly playing: boolean;
}

export function PreviewEffectOverlay({
  layers,
  getSource,
  getTime,
  playing,
}: PreviewEffectOverlayProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Painted at least one real frame — until then the raw video shows through. */
  const [painting, setPainting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const layerIndex = useMemo(() => buildTemporalIndex(layers), [layers]);

  useEffect(() => {
    if (layers.length === 0 || unavailable) {
      setPainting(false);
      return;
    }

    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;

      const canvas = canvasRef.current;
      if (canvas === null) return;
      const time = getTime();
      // End-exclusive, matching `activeEffectLayersAt` and the engine, so two
      // abutting layers never both fire on the boundary frame.
      const live = activeTimedItemsAt(layerIndex, time).filter((l) => l.disabled !== true);
      if (live.length === 0) {
        if (painting) setPainting(false);
        if (playing) rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const source = getSource();
      if (!sourceReady(source)) {
        if (playing) rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const processed = chain().process(source as TexImageSource, live, time);
      if (processed === null) {
        // No WebGL, or every shader failed. Stop and let the untouched video
        // show rather than covering it with a black rectangle.
        log.warn('tick ← effect chain unavailable, preview shows the raw picture');
        setUnavailable(true);
        return;
      }

      const out = processed as HTMLCanvasElement;
      // Match the source's intrinsic size so the effect samples at full detail;
      // CSS scales the canvas into the frame exactly as it does the video.
      if (canvas.width !== out.width || canvas.height !== out.height) {
        canvas.width = out.width;
        canvas.height = out.height;
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.drawImage(out, 0, 0);
      if (!painting) setPainting(true);
      if (playing) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // `painting` is intentionally absent: including it would tear down and
    // restart the loop on the first painted frame. (No eslint-disable — this
    // repo's lint baseline has no react-hooks plugin, so the directive itself
    // would be an error.)
  }, [layers, layerIndex, getSource, getTime, playing, unavailable]);

  if (layers.length === 0 || unavailable) return null;
  return (
    <canvas
      className="preview-effect-canvas"
      ref={canvasRef}
      // Hidden until a real frame lands, so applying an effect never flashes an
      // empty rectangle over the picture.
      data-painting={painting || undefined}
      aria-hidden="true"
    />
  );
}
