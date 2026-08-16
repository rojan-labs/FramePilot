/**
 * Transition tile artwork: two real photographs with the real transition running
 * between them on hover.
 *
 * ## Why two frames
 *
 * A transition is a *relationship*. A wipe drawn over one picture is invisible; a
 * dissolve between a picture and itself is a no-op. So the tile paints an outgoing
 * frame, then draws the incoming frame through the entry's actual shader over the
 * top — which is exactly what the timeline does at a cut, and exactly what the
 * export mirrors in numpy. Nobody has to trust a canned preview clip: the tile IS
 * the renderer.
 *
 * Static and hover show the same pair (`photo-frame.ts`), so hovering reads as
 * the transition starting rather than as the image being swapped.
 *
 * ## Why one shared GL context
 *
 * A context per tile would exhaust the browser's ~16-context limit on the first
 * scroll of a 77-tile grid. Only one tile is hovered at a time, so there is
 * nothing to contend over — `sharedTransitionChain()` owns it.
 */
import { useEffect, useRef, useState } from 'react';
import type { CatalogTransition } from '@framepilot/timeline-schema/transition-catalog';
import { sharedTransitionChain } from '../preview/transitions/gl-transition-chain.js';
import { resolveTransitionParamsFor } from '../preview/transitions/transition-engine.js';
import { photoFrameReady, photoFrameUrl } from './photo-frame.js';

/** Preview resolution. Small enough that even a nine-tap blur is cheap per frame. */
const PREVIEW_PX = 192;

/** Seconds of the loop: the transition, then a beat on the finished shot. */
const LOOP_SECONDS = 1.8;
const SETTLE_FRACTION = 0.72;

export interface TransitionThumbnailProps {
  readonly transition: CatalogTransition;
  /** Hovered or focused — drives the animated loop. */
  readonly active: boolean;
  /**
   * Honour `prefers-reduced-motion`: the loop is replaced by a single held frame
   * at the transition's midpoint, which still shows what it does.
   */
  readonly reducedMotion?: boolean;
}

export function TransitionThumbnail({
  transition,
  active,
  reducedMotion = false,
}: TransitionThumbnailProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Set once WebGL proves unavailable, so we stop retrying and keep the stills. */
  const [glFailed, setGlFailed] = useState(false);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (!active || glFailed) {
      setPainted(false);
      return;
    }
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const resolved = resolveTransitionParamsFor({
      kind: transition.id,
      durationSeconds: transition.defaultDuration,
    });
    if (resolved === null) return;

    let cancelled = false;

    const draw = (from: HTMLImageElement, to: HTMLImageElement, progress: number): boolean => {
      ctx.clearRect(0, 0, PREVIEW_PX, PREVIEW_PX);
      ctx.drawImage(from, 0, 0, PREVIEW_PX, PREVIEW_PX);
      const processed = sharedTransitionChain().process(to, resolved, progress);
      if (processed === null) return false;
      ctx.drawImage(processed as CanvasImageSource, 0, 0, PREVIEW_PX, PREVIEW_PX);
      return true;
    };

    Promise.all([photoFrameReady('a'), photoFrameReady('b')]).then(([from, to]) => {
      if (cancelled || from === null || to === null) return;

      if (reducedMotion) {
        // One frame at the midpoint: the moment that actually shows what the
        // transition is, without anything moving.
        if (!draw(from, to, 0.5)) setGlFailed(true);
        else setPainted(true);
        return;
      }

      const started = performance.now();
      const tick = (): void => {
        if (cancelled) return;
        const elapsed = ((performance.now() - started) / 1000) % LOOP_SECONDS;
        // The loop settles on the finished shot before repeating, so a viewer sees
        // where the transition LANDS rather than an endless mid-blend.
        const progress = Math.min(1, elapsed / (LOOP_SECONDS * SETTLE_FRACTION));
        if (!draw(from, to, progress)) {
          // No GL, or this shader failed to compile. Stop and let the stills stand
          // rather than looping on a black tile.
          setGlFailed(true);
          return;
        }
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
    // `painted` is deliberately ABSENT from the deps: including it would tear down
    // and restart the loop on the first painted frame, every time. (No
    // eslint-disable — this repo's lint baseline has no react-hooks plugin, so a
    // directive for it is itself an error. Documented instead, matching
    // EffectThumbnail.)
  }, [active, glFailed, reducedMotion, transition]);

  return (
    <span className="tr-thumb" aria-hidden="true">
      {/*
        The still is the two frames side by side with a hairline between them —
        which reads, correctly, as "a cut". Hovering is then literally the cut
        being treated.
      */}
      <span
        className="tr-thumb-still tr-thumb-still--from"
        style={{ backgroundImage: `url(${photoFrameUrl('a')})`, ...(painted ? { opacity: 0 } : {}) }}
      />
      <span
        className="tr-thumb-still tr-thumb-still--to"
        style={{ backgroundImage: `url(${photoFrameUrl('b')})`, ...(painted ? { opacity: 0 } : {}) }}
      />
      {active && !glFailed && (
        <canvas
          className="tr-thumb-canvas"
          ref={canvasRef}
          width={PREVIEW_PX}
          height={PREVIEW_PX}
          data-painted={painted || undefined}
        />
      )}
    </span>
  );
}
