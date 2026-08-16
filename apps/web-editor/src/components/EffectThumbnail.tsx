/**
 * Effect tile artwork: a still frame that runs the real effect on hover.
 *
 * Static and hover show the SAME picture (`photo-frame.ts`), so hovering reads
 * as the effect switching on rather than as the image being swapped. The still
 * is a plain `<img>` with the catalog's cheap CSS approximation, which costs
 * nothing for a 72-tile grid; only the hovered tile touches the GPU.
 *
 * WHY one shared GL context for the whole grid: a context per tile would exhaust
 * the browser's ~16-context limit on the first scroll. Only one tile is hovered
 * at a time, so there is nothing to contend over.
 */
import { useEffect, useRef, useState } from 'react';
import type { CatalogEffect } from '@framepilot/timeline-schema/effect-catalog';
import { resolveParams } from '@framepilot/timeline-schema/effect-catalog';
import { GlEffectChain, type TimedEffectLayer } from '../preview/effects/gl-effect-chain.js';
import { photoFrameReady, photoFrameUrl } from './photo-frame.js';

/** Preview resolution. Small enough that even a 64px blur is cheap per frame. */
const PREVIEW_PX = 192;

/** Seconds of the effect's own span the hover loop walks, then repeats. */
const LOOP_SECONDS = 2;

/**
 * The one chain shared by every tile, created on first hover and kept for the
 * session — disposing on unmount would mean a fresh context and a possible
 * recompile every time the panel is closed and reopened.
 */
let sharedChain: GlEffectChain | null = null;

function chain(): GlEffectChain {
  sharedChain ??= new GlEffectChain(() => document.createElement('canvas'));
  return sharedChain;
}

export interface EffectThumbnailProps {
  readonly effect: CatalogEffect;
  /** Hovered or focused — drives the animated shader loop. */
  readonly active: boolean;
}

export function EffectThumbnail({ effect, active }: EffectThumbnailProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Set once WebGL proves unavailable, so we stop retrying and keep the still. */
  const [glFailed, setGlFailed] = useState(false);
  /** Only swap to the canvas once it holds a frame, so no blank flash. */
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (!active || glFailed) {
      setPainted(false);
      return;
    }
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const outCtx = canvas.getContext('2d');
    if (outCtx === null) return;

    const layer: TimedEffectLayer = {
      kind: effect.kind,
      start: 0,
      end: LOOP_SECONDS,
      params: resolveParams(effect),
    };

    let cancelled = false;

    photoFrameReady('a').then((source) => {
      if (cancelled || source === null) return;
      const started = performance.now();

      const tick = (): void => {
        if (cancelled) return;
        // Loop within the layer's own span so time-varying effects animate and
        // envelope effects (zoom punch, flash) play their whole gesture.
        const t = ((performance.now() - started) / 1000) % LOOP_SECONDS;
        const processed = chain().process(source, [layer], t);
        if (processed === null) {
          // No GL, or this shader failed to compile. Stop and let the still stand
          // rather than looping on a black tile.
          setGlFailed(true);
          return;
        }
        outCtx.clearRect(0, 0, PREVIEW_PX, PREVIEW_PX);
        outCtx.drawImage(processed as CanvasImageSource, 0, 0, PREVIEW_PX, PREVIEW_PX);
        if (!painted) setPainted(true);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    });

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // `painted` is deliberately ABSENT from the deps: including it would tear
    // down and restart the loop on the first painted frame, every time.
    // (No eslint-disable — this repo's lint baseline has no react-hooks plugin,
    // so a directive for it is itself an error. Documented instead, matching
    // webcodecs-preview-engine.ts.)
  }, [active, effect, glFailed]);

  return (
    <span className="fx-thumb" aria-hidden="true">
      <img
        className="fx-thumb-still"
        src={photoFrameUrl('a')}
        alt=""
        draggable={false}
        // The catalog's cheap approximation, so the still already hints at the
        // look before anyone hovers. Hidden once the accurate shader frame lands.
        style={{
          ...(effect.thumbnail.css !== undefined ? { filter: effect.thumbnail.css } : {}),
          ...(painted ? { opacity: 0 } : {}),
        }}
      />
      {active && !glFailed && (
        <canvas
          className="fx-thumb-canvas"
          ref={canvasRef}
          width={PREVIEW_PX}
          height={PREVIEW_PX}
          data-painted={painted || undefined}
        />
      )}
    </span>
  );
}
